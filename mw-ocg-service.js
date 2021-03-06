#!/usr/bin/env node
'use strict';

/**
 * Collection Extension render wrangler
 *
 * This script starts and maintains a HTTP endpoint and several children
 * to render and retrieve MediaWiki documents (collections / books) into
 * various formats.
 *
 * It is the backend to which the PHP frontend will talk. It probably
 * should not be connected to the public internet! :)
 *
 * https://www.mediawiki.org/wiki/Extension:Collection
 *
 * @section LICENSE
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 * http://www.gnu.org/copyleft/gpl.html
 *
 * @file
 */

var cli = require('./lib/cli.js');
var cluster = require('cluster');
var commander = require('commander');
var os = require('os');

// Parse command-line options (with a possible additional config file override).
commander
	.version(cli.version)
	.option('-c, --config <path>', 'Path to the local configuration file')
	.parse(process.argv);

var config = cli.parseConfig(commander.config);
cli.setupLogging(config);
cli.setupStatsD(config);

/* === Fork the heck out of ourselves! ========================================
 * The basic idea is that we have this controlling process which launches and
 * maintains a configurable number of child threads. The type of thread a child
 * should be is placed into the OCG_SERVICE_CHILD_TYPE environment variable.
 *
 * Children must
 * -- have a basic API of init(config), start(), and stop(callback)
 * -- be able to gracefully shutdown :)
 *
 * Sending a SIGINT to a child (or the controller) will start a graceful
 * shutdown.
 * */

if (cluster.isMaster) {
	var respawnWorkers = true;
	var workerTypes = {};
	var lastRestart = {};
	var autoThreads;
	var i;

	/* --- Thread management --- */
	var gracefulShutdown = function gracefulShutdown() {
		respawnWorkers = false;
		console.info('Beginning graceful shutdown');

		for (var id in cluster.workers) {
			console.info('Sending shutdown command to worker %s', id);
			cluster.workers[id].kill('SIGINT');
		}

		var infoAndExit = function() {
			var stillAlive = Object.keys(cluster.workers).length;
			if (stillAlive > 0) {
				console.info('Still awaiting death of %d workers', stillAlive);
				setTimeout(infoAndExit, 1000);
			} else {
				console.info('All threads killed. Exiting.');
				process.exit();
			}
		};
		infoAndExit();
	};

	var immediateShutdown = function immediateShutdown() {
		respawnWorkers = false;
		console.info('Shutting down immediately');

		var workers = cluster.workers;
		Object.keys(workers).forEach(function(id) {
			console.info('Killing worker %s', id);
			workers[id].destroy();
		});
		process.exit(1);
	};

	process.on('SIGINT', gracefulShutdown);
	process.on('SIGTERM', gracefulShutdown);
	process.on('SIGHUP', immediateShutdown);

	var spawnWorker = function spawnWorker(workerType) {
		var newWorker = null;
		lastRestart[workerType] = Date.now();
		statsd.increment(workerType + '.restarts');
		newWorker = cluster.fork({OCG_SERVICE_CHILD_TYPE: workerType});
		workerTypes[newWorker.process.pid] = workerType;
		console.debug('Spawned %s worker with PID %s', workerType, newWorker.process.pid);
	};

	cluster.on('disconnect', function(worker) {
		console.info(
			'Worker (pid %d) has disconnected. Suicide: %s. Restarting: %s.',
			worker.process.pid,
			worker.suicide,
			respawnWorkers
		);
		if (respawnWorkers) {
			if (lastRestart[workerTypes[worker.process.pid]] > Date.now() - 1000) {
				// Only allow a restart of a backend thread once a second
				console.info(
					'Cannot immediately respawn thread. Waiting 1s to avoid forkbombing.'
				);
				setTimeout(spawnWorker, 1000, workerTypes[worker.process.pid]);
			} else {
				spawnWorker(workerTypes[worker.process.pid]);
			}
		}
		delete workerTypes[worker.process.pid];
	}
	);

	spawnWorker('gc');

	for (i = 0; i < config.coordinator.frontend_threads; i++) {
		spawnWorker('frontend');
	}

	autoThreads = config.coordinator.backend_threads;
	if (autoThreads === 'auto') {
		autoThreads = os.cpus().length;
	}
	for (i = 0; i < autoThreads; i++) {
		spawnWorker('backend');
	}

} else {
	var types = {
		frontend: './lib/threads/frontend.js',
		backend:  './lib/threads/backend.js',
		gc: './lib/threads/gc.js',
	};
	var child;

	if (process.env.OCG_SERVICE_CHILD_TYPE in types) {
		child = require(types[process.env.OCG_SERVICE_CHILD_TYPE]);
	} else {
		console.error(
			'Could not launch child of type "%s", terminating', process.env.OCG_SERVICE_CHILD_TYPE
		);
		process.abort();
	}

	process.on('SIGINT', function() {
		// Master wants us to die :(
		console.debug('%s worker received SIGINT', process.env.OCG_SERVICE_CHILD_TYPE);
		child.stop(process.exit);
	});

	child.init(config);
	child.start();
}

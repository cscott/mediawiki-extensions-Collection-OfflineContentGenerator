#!/usr/bin/env node

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

var cluster = require('cluster');
var nconf = require('nconf');
var os = require('os');
require('rconsole');
var sleep = require('sleep');

/* === Configuration Options & File ======================================== */
nconf
	.argv({
		c: {
			alias: 'config=file',
			describe: 'Local configuration file',
			default: '/etc/collectoid.json'
		}
	})
	.file({file: nconf.get('config=file')})
	.file({file: 'defaults.json'});

/* === Initial Logging ===================================================== */
console.set({
	facility: 'local0',
	title: 'collectoid'
});

/* === Fork the heck out of ourselves! ========================================
* The basic idea is that we have this controlling process which launches and
* maintains a configurable number of child threads. The type of thread a child
* should be is placed into the COLLECTOID_CHILD_TYPE environment variable.
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
	var newWorker = null;
	var autoThreads = 0;
	var i = 0;

	/* --- Thread management --- */
	function gracefulShutdown() {
		var stillAlive = 0;

		respawnWorkers = false;
		console.info('Beginning graceful shutdown');

		for (var id in cluster.workers) {
			console.info('Sending shutdown command to %d', id);
			cluster.workers[id].kill('SIGINT');
		}

		do {
			stillAlive = Object.keys(cluster.workers).length;
			if (stillAlive > 0) {
				console.info('Still awaiting death of %d workers', stillAlive);
				sleep.sleep(1);
			} else {
				console.info('All threads killed. Exiting.');
				process.exit();
			}
		} while (stillAlive > 0);
	}

	function immediateShutdown() {
		respawnWorkers = false;
		console.info('Shutting down immediately');

		var workers = cluster.workers;
		Object.keys(workers).forEach(function(id) {
			console.info('Killing frontend worker ' + id);
			workers[id].destroy();
		});
		process.exit(1);
	}
	process.on('SIGINT', gracefulShutdown);
	process.on('SIGTERM', gracefulShutdown);
	process.on('SIGHUP', immediateShutdown);

	cluster.on('disconnect', function(worker) {
		console.info(
			'Worker (pid %d) has disconnected. Suicide: %s. Restarting: %s.',
			worker.process.pid,
			worker.suicide,
			respawnWorkers
		);
		if (respawnWorkers) {
			newWorker = cluster.fork({COLLECTOID_CHILD_TYPE: workerTypes[worker.process.pid]});
			workerTypes[newWorker.process.pid] = workerTypes[worker.process.pid];
		}
		delete workerTypes[worker.process.pid];
	});

	for (i = 0; i < nconf.get('coordinator:frontend_threads'); i++) {
		newWorker = cluster.fork({COLLECTOID_CHILD_TYPE: 'frontend'});
		workerTypes[newWorker.process.pid] = 'frontend';
	}

	autoThreads = nconf.get('coordinator:backend_threads');
	if (autoThreads === 'auto') {
		autoThreads = os.cpus().length;
	}
	for (i = 0; i < autoThreads; i++) {
		newWorker = cluster.fork({COLLECTOID_CHILD_TYPE: 'backend'});
		workerTypes[newWorker.process.pid] = 'backend';
	}

} else {
	var types = {
		'frontend': './lib/frontend.js',
		'backend': './lib/backend.js'
	};
	var child;

	if (process.env.COLLECTOID_CHILD_TYPE in types) {
		child = require(types[process.env.COLLECTOID_CHILD_TYPE]);
	} else {
		console.error('Could not launch child of type "%s", terminating', process.env.COLLECTOID_CHILD_TYPE);
		process.abort();
	}

	process.on('SIGINT', function() {
		// Master wants us to die :(
		console.debug('%s worker received SIGINT', process.env.COLLECTOID_CHILD_TYPE);
		child.stop(process.exit);
	});

	child.init(nconf);
	child.start();
}

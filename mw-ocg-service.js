#!/usr/bin/env node
"use strict";

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

var cluster = require( 'cluster' );
var commander = require( 'commander' );
var path = require( 'path' );
var StatsD = require( './lib/statsd.js' );
var os = require( 'os' );
var logger = require( 'winston' );

/* === Configuration Options & File ======================================== */
var config = require( './defaults.js' );
commander
	.version( '0.0.1' )
	.option( '-c, --config <path>', 'Path to the local configuration file' )
	.parse( process.argv );

try {
	if ( commander.config ) {
		if ( path.resolve( commander.config ) !== path.normalize( commander.config ) ) {
			// If the configuration path given is relative, resolve it to be relative
			// to the current working directory instead of relative to the path of this
			// file.
			commander.config = path.resolve( process.cwd, commander.config );
		}
		config = require( commander.config )( config );
	}
} catch ( err ) {
	console.error( "Could not open configuration file %s! %s", commander.config, err );
	process.exit( 1 );
}

/* === Initial Logging ===================================================== */
// Remove the default logger
logger.remove( logger.transports.Console );
// Now go through the hash and add all the required transports
for ( var transport in config.logging ) {
	console.info(JSON.stringify(config.logging));
	if ( config.logging.hasOwnProperty( transport ) ) {
		var parts = transport.split( '/' );
		var classObj = require( parts.shift() );
		parts.forEach( function( k ) {
			classObj = classObj[k];
		} );
		logger.add( classObj, config.logging[transport] );
	}
}
logger.extend( console );

global.statsd = new StatsD(
	config.reporting.statsd_server,
	config.reporting.statsd_port,
	config.reporting.prefix,
	'',
	config.reporting.is_txstatsd,
	false, // Don't globalize, we're doing that here
	true,  // Do cache DNS queries
	config.reporting.enable
);

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

if ( cluster.isMaster ) {
	var respawnWorkers = true;
	var workerTypes = {};
	var lastRestart = {};
	var autoThreads;
	var i;

	/* --- Thread management --- */
	var gracefulShutdown = function gracefulShutdown() {
		respawnWorkers = false;
		console.info( 'Beginning graceful shutdown' );

		for ( var id in cluster.workers ) {
			console.info( 'Sending shutdown command to worker %s', id );
			cluster.workers[id].kill( 'SIGINT' );
		}

		var infoAndExit = function () {
			var stillAlive = Object.keys( cluster.workers ).length;
			if ( stillAlive > 0 ) {
				console.info( 'Still awaiting death of %d workers', stillAlive );
				setTimeout( infoAndExit, 1000 );
			} else {
				console.info( 'All threads killed. Exiting.' );
				process.exit();
			}
		};
		infoAndExit();
	};

	var immediateShutdown = function immediateShutdown() {
		respawnWorkers = false;
		console.info( 'Shutting down immediately' );

		var workers = cluster.workers;
		Object.keys( workers ).forEach( function ( id ) {
			console.info( 'Killing frontend worker %s', id );
			workers[id].destroy();
		}
		);
		process.exit( 1 );
	};

	process.on( 'SIGINT', gracefulShutdown );
	process.on( 'SIGTERM', gracefulShutdown );
	process.on( 'SIGHUP', immediateShutdown );

	var spawnWorker = function spawnWorker( workerType ) {
		var newWorker = null;
		lastRestart[workerType] = Date.now();
		statsd.increment( workerType + '.restarts' );
		newWorker = cluster.fork( {COLLECTOID_CHILD_TYPE: workerType} );
		workerTypes[newWorker.process.pid] = workerType;
		console.debug( "Spawned %s worker with PID %s", workerType, newWorker.process.pid );
	};

	cluster.on( 'disconnect', function ( worker ) {
		console.info(
			'Worker (pid %d) has disconnected. Suicide: %s. Restarting: %s.',
			worker.process.pid,
			worker.suicide,
			respawnWorkers
		);
		if ( respawnWorkers ) {
			if ( lastRestart[workerTypes[worker.process.pid]] > Date.now() - 1000 ) {
				// Only allow a restart of a backend thread once a second
				console.info(
					"Cannot immediately respawn thread. Waiting 1s to avoid forkbombing."
				);
				setTimeout( spawnWorker, 1000, workerTypes[worker.process.pid] );
			} else {
				spawnWorker( workerTypes[worker.process.pid] );
			}
		}
		delete workerTypes[worker.process.pid];
	}
	);

	for ( i = 0; i < config.coordinator.frontend_threads; i++ ) {
		spawnWorker( 'frontend' );
	}

	autoThreads = config.coordinator.backend_threads;
	if ( autoThreads === 'auto' ) {
		autoThreads = os.cpus().length;
	}
	for ( i = 0; i < autoThreads; i++ ) {
		spawnWorker( 'backend' );
	}

} else {
	var types = {
		'frontend': './lib/threads/frontend.js',
		'backend':  './lib/threads/backend.js'
	};
	var child;

	if ( process.env.COLLECTOID_CHILD_TYPE in types ) {
		child = require( types[process.env.COLLECTOID_CHILD_TYPE] );
	} else {
		console.error(
			'Could not launch child of type "%s", terminating', process.env.COLLECTOID_CHILD_TYPE
		);
		process.abort();
	}

	process.on( 'SIGINT', function () {
		// Master wants us to die :(
		console.debug( '%s worker received SIGINT', process.env.COLLECTOID_CHILD_TYPE );
		child.stop( process.exit );
	} );

	child.init( config );
	child.start();
}

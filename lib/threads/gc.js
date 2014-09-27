"use strict";
/**
 * This file is part of the Collection Extension to MediaWiki
 * https://www.mediawiki.org/wiki/Extension:Collection
 *
 * The garbage collection thread will
 * - Delete JobStatus objects after `gc.completed_job_lifetime`
 * - Delete job files after `gc.completed_job_file_lifetime`
 * - Clear the temp folder after `gc.temp_file_lifetime`
 * - Clear the postmortem folder after `gc.postmortem_file_lifetime`
 *
 * The thread will run every `gc.every` seconds
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

require( 'es6-shim' );
require( 'prfun' );

var fs = require( 'fs' );
var path = require( 'path' );
var rimraf = require( 'rimraf' );

var eh = require( '../errorhelper.js' );
var jd = require( '../JobDetails.js' );
var Redis = require( '../RedisWrapper.js' );

var config = null;
var running = false;
var intervalTimer = null;
var redisClient = null;

/* === Public Exported Functions =========================================== */
/**
 * Initialize the frontend server with global objects
 *
 * @param config_obj Configuration object
 */
function init( config_obj ) {
	config = config_obj;
	redisClient = new Redis(
		config.redis.host,
		config.redis.port,
		config.redis.password
	);
}

/**
 * Starts the garbage collection thread.
 */
function startThread() {
	running = true;

	redisClient.on( 'closed', function () {
		if ( running ) {
			console.error( 'Garbage collector connection to redis died, killing thread.', {
				channel: 'gc.error.fatal'
			} );
			stopThread( process.exit );
		}
	} );
	redisClient.on('opened', function() {
		intervalTimer = setInterval( doGCRun, config.garbage_collection.every * 1000 );
	} );
	redisClient.connect();
}

function doSingleRun() {
	redisClient.on( 'closed', function () {
		if ( running ) {
			console.error( 'Garbage collector connection to redis died, killing thread.', {
				channel: 'gc.error.fatal'
			} );
			stopThread( process.exit );
		}
	} );
	redisClient.connect();
	return new Promise( function( resolve, reject ) {
		redisClient.on('opened', function() {
			doGCRun().then( resolve ).catch( reject );
		} );
	} );
}

/**
 * Stops (closes) the frontend server
 *
 * @param callbackFunc Function to call when server successfully closed
 */
function stopThread( callbackFunc ) {
	running = false;
	redisClient.close();
	if ( callbackFunc ) { setTimeout( callbackFunc, 1); }
}

/* ==== The meat === */
function doGCRun() {
	var startTime = Date.now();

	return Promise.resolve()
		.then(clearJobStatusObjects)
		.then(clearOutputDir)
		.then(clearTempDir)
		.then(clearPostmortemDir)
		.then( function() {
			console.info( "Finished GarbageCollection run in %s seconds",
				( ( Date.now() - startTime ) / 1000 ), { channel: 'gc' } );
			statsd.timing( 'gc.runtime', ( Date.now() - startTime ) / 1000 );
		} );
}

/**
 * Iterate through all JobStatus objects in Redis and clear those
 * that are too old.
 */
function clearJobStatusObjects() {
	var clearedFailedJobs = 0,
		clearedNonFailedJobs = 0,
		fjl = Date.now() - config.garbage_collection.failed_job_lifetime,
		ajl = Date.now() - config.garbage_collection.job_lifetime;

	console.info( "Starting run to clear job status objects", { channel: 'gc' } );
	var scrubKey = function( key ) {
		return redisClient.hget( config.redis.status_set_name, key ).then( function( jdjson ) {
			var job = jd.fromJson( jdjson );
			if ( job.status === 'failed' && ( job.timestamp < fjl ) ) {
				clearedFailedJobs += 1;
				return redisClient.hdel( config.redis.status_set_name, job.collectionId );
			} else if ( job.timestamp < ajl ) {
				clearedNonFailedJobs += 1;
				return redisClient.hdel( config.redis.status_set_name, job.collectionId );
			}
		} );
	};
	var scrubKeyGuarded = Promise.guard( Promise.guard.n( 5 ), scrubKey );

	return redisClient.hkeys( config.redis.status_set_name ).then( function( keys ) {
		console.info( "Got %s status keys to iterate through", keys.length, { channel: 'gc' } );
		return keys;
	} ).map( scrubKeyGuarded ).then( function() {
		console.info(
			"Cleared %s non-failed jobs and %s failed jobs",
			clearedNonFailedJobs,
			clearedFailedJobs,
			{ channel: 'gc' }
		);
	} );
}

function cleanDir( dir, lifetime ) {
	var expire = Date.now() - ( lifetime * 1000 );
	var count = 0;
	if (!dir) { return Promise.resolve(); }
	return Promise.promisify( fs.readdir, false, fs )( dir ).then( function( files ) {
		return Promise.map( files, function( file ) {
			return Promise.promisify( fs.stat, false, fs )( path.join( dir, file ) )
				.then( function ( stat ) {
					if ( stat.ctime.getTime() < expire ) {
						count += 1;
						return Promise.promisify( rimraf )( path.join( dir, file ) );
					}
				} );
		} ).then( function() {
			console.info( 'Cleared %s files from %s', count, dir, { channel: 'gc' } );
		} );
	} );
}

function clearOutputDir() {
	return cleanDir( config.backend.output_dir, config.garbage_collection.job_file_lifetime );
}

function clearTempDir() {
	return cleanDir( config.backend.temp_dir, config.garbage_collection.temp_file_lifetime );
}

function clearPostmortemDir() {
	return cleanDir(
		config.backend.post_mortem_dir,
		config.garbage_collection.postmortem_file_lifetime
	);
}

exports.init = init;
exports.start = startThread;
exports.stop = stopThread;
exports.singleRun = doSingleRun;

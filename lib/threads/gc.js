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

var backend = require( './backend.js' );
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
	config = backend.initDirectories( config_obj );
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

function doSingleRun( what ) {
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
			Promise.resolve().then(what || doGCRun).then( resolve, reject );
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
		.then(cleanExpiredJobStatusObjects)
		.then(cleanOutputDir)
		.then(cleanTempDir)
		.then(cleanPostmortemDir)
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
function cleanExpiredJobStatusObjects() {
	var clearedFailedJobs = 0,
		clearedNonFailedJobs = 0,
		// job lifetimes are in seconds.
		fjl = Date.now() - (config.garbage_collection.failed_job_lifetime * 1000),
		ajl = Date.now() - (config.garbage_collection.job_lifetime * 1000);

	console.info(
		"Starting run to clean job status objects",
		{ channel: 'gc' }
	);
	return cleanJobStatusObjects(function( job ) {
		if ( job.state === 'failed' && ( job.timestamp < fjl ) ) {
			clearedFailedJobs += 1;
			return true; // delete this job
		} else if ( job.timestamp < ajl ) {
			clearedNonFailedJobs += 1;
			return true; // delete this job
		}
		return false; // keep this job
	}).spread(function( total, deleted ) {
		console.info(
			"Got %d status keys to iterate through",
			total,
			{ channel: 'gc' }
		);
		console.info(
			"Cleared %d non-failed jobs and %d failed jobs",
			clearedNonFailedJobs,
			clearedFailedJobs,
			{ channel: 'gc' }
		);
	});
}

/**
 * Iterate through all JobStatus objects in Redis and clear those
 * for which the `shouldDeleteJob` function returns `true`.
 */
function cleanJobStatusObjects(shouldDeleteJob) {
	var total = 0, deleted = 0;

	var scrubKey = function( key, jdjson ) {
		var job = jd.fromJson( jdjson );
		if ( shouldDeleteJob( job ) ) {
			deleted += 1;
			return redisClient.hdel( config.redis.status_set_name, job.collectionId );
		}
	};
	var scrubKeyGuarded = Promise.guard( Promise.guard.n( 5 ), scrubKey );

	var scanSome = function( cursor ) {
		return redisClient.hscan( config.redis.status_set_name, cursor ).
			spread( function( cursor, kvs ) {
				var tasks = [], i;
				for (i = 0; i < kvs.length; i += 2) {
					var k = kvs[ i ], v = kvs[ i+1 ];
					tasks.push( scrubKeyGuarded( k, v ) );
					total++;
				}
				return Promise.all(tasks).then( function() {
					if ( (+cursor) === 0) {
						return; // done!
					}
					return scanSome( cursor );
				});
			});
	};

	return scanSome( 0 ).then( function() {
		return [ total, deleted ];
	} );
}

var cleanDir = (function() {
	var limit = Promise.guard.n( 100 ); // limit parallelism
	var lstat = Promise.guard( limit, Promise.promisify( fs.lstat, false, fs ) );
	var readdir = Promise.guard( limit, Promise.promisify( fs.readdir, false, fs ) );
	var rmdir = Promise.guard( limit, Promise.promisify( fs.rmdir, false, fs ) );
	var unlink = Promise.guard( limit, Promise.promisify( fs.unlink, false, fs ) );

	// the optional `force` parameter gives the # of levels of directories
	// into which we should recurse, regardless of mtime.  We always recurse
	// into the directory given as the `dir` argument.  Setting `force` to
	// 1 means we'll always recurse into all directories immediately below
	// `dir` as well, etc.
	return Promise.method( function( dir, lifetime, force ) {
		// file lifetimes are in seconds
		var expire = Date.now() - ( lifetime * 1000 );
		var count = 0, errors = [];
		if (!dir || !lifetime) { return; }
		var clean = function( dir, force ) {
			// ensure that we don't blow up our memory usage by trying to
			// do a breadth-first traversal of the directory tree.
			var dfsclean = Promise.guard( 1, clean );
			return readdir( dir ).catch( function( e ) {
				// directory already removed?
				errors.push({
					msg: "readdir: " + e,
					path: dir
				});
				return [];
			}).map( function( file ) {
				var fullpath = path.join( dir, file );
				return lstat( fullpath ).then(function( stat ) {
					// skip files/directories based on modification time
					// (Note that a directory's mtime is updated whenever
					// anything is added to it; you will need to manually
					// tweak the mtime of directories you want to be sure
					// to recurse into despite their contents changing.)
					if ( stat.mtime.getTime() > expire &&
						 ( stat.isDirectory() ? force === 0 : true ) ) {
						return; // safe!
					}
					if ( stat.isDirectory() ) {
						var f = ( force > 0 ) ? force - 1 : 0;
						return dfsclean( fullpath, f ).then( function() {
							return readdir( fullpath ).then( function( files ) {
								if (files.length === 0) {
									return rmdir( fullpath ).then(function(){
										count += 1;
									}, function( e ) {
										errors.push({
											msg: "rmdir: " + e,
											path: fullpath
										});
									});
								}
							}, function( e ) {
								/* it went away after we cleaned it? */
								errors.push({
									msg: "readdir after clean: " + e,
									path: fullpath
								});
							});
						});
					} else {
						return unlink( fullpath ).then(function() {
							count += 1;
						}, function( e ) {
							errors.push({
								msg: "unlink: " + e,
								path: fullpath
							});
						});
					}
				}, function( e ) {
					// error during stat -- file already gone?
					errors.push({
						msg: "stat: " + e,
						path: fullpath
					});
				});
			});
		};

		return clean( dir, force || 0 ).then( function() {
			console.info( 'Cleared %d files from %s with %d errors', count, dir, errors.length, { channel: 'gc', errors: errors.length, paths: JSON.stringify(errors) });
		} );
	} );
})();

function cleanOutputDir() {
	return cleanDir(
		config.backend.output_dir,
		config.garbage_collection.job_file_lifetime,
		1
	);
}

function cleanTempDir() {
	return cleanDir(
		config.backend.temp_dir,
		config.garbage_collection.temp_file_lifetime,
		0
	);
}

function cleanPostmortemDir() {
	return cleanDir(
		config.backend.post_mortem_dir,
		config.garbage_collection.postmortem_file_lifetime,
		0
	);
}

exports.init = init;
exports.start = startThread;
exports.stop = stopThread;
exports.singleRun = doSingleRun;

exports.cleanDir = cleanDir;
exports.cleanJobStatusObjects = cleanJobStatusObjects;

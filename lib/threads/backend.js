"use strict";
/**
 * This file is part of the Collection Extension to MediaWiki
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

require( 'es6-shim' );
require( 'prfun' );

var child_process = require( 'child_process' );
var eh = require( '../errorhelper.js' );
var fs = require( 'fs' );
var mkdirp = require('mkdirp');
var mime = require( 'mime' );
var mv = require('mv');
var path = require( 'path' );
var rimraf = require( 'rimraf' );
var os = require( 'os' );
var sprintf = require( 'sprintf-js' ).sprintf;
var util = require( 'util' );

var jd = require( '../JobDetails.js' );
var Redis = require( '../RedisWrapper.js' );

var config = null;
var redisClient = null;

/* === Public Exported Functions =========================================== */
/**
 * Initialize the frontend server with global objects
 *
 * @param {hash} config_obj - Configuration object
 */
function initBackend( config_obj ) {
	var writer, paths;

	config = config_obj;
	if ( !config.backend.temp_dir ) {
		if ( os.tmpdir ) {
			config.backend.temp_dir = os.tmpdir();
		} else {
			// Node < 0.10
			config.backend.temp_dir = os.tmpDir();
		}
	}
	// create the temp dir if necessary
	mkdirp.sync(config.backend.temp_dir);

	if ( !config.backend.output_dir ) {
		config.backend.output_dir = path.join( config.backend.temp_dir, 'ocg-output' );
	}
	// create the output directory if necessary
	mkdirp.sync(config.backend.output_dir);

	redisClient = new Redis(
		config.redis.host,
		config.redis.port,
		config.redis.password
	);

	// Do some brief sanity checking
	paths = [
		config.backend.temp_dir,
		config.backend.output_dir,
		config.backend.bundler.bin
	];
	for ( writer in config.backend.writers ) {
		if ( config.backend.writers.hasOwnProperty( writer ) ) {
			paths.push( config.backend.writers[writer].bin );
		}
	}
	if ( config.backend.post_mortem_dir ) { paths.push( config.backend.post_mortem_dir ); }
	paths.forEach( function ( value ) {
		if ( !fs.existsSync( value )  ) {
			console.error(
				"Configuration error: Cannot determine if %s exists!",
				path.resolve( value ),
				{ channel: 'backend.error.fatal' }
			);
			process.exit( 1 );
		}
	} );
}

/**
 * Starts the backend server
 */
function startBackend() {
	var loop = false;
	redisClient.on( 'closed', function () {
		if ( !loop ) {
			loop = true;
			console.error(
				'Backend connection to redis died unexpectedly.',
				{ channel: 'backend.error.fatal' }
			);
			stopBackend( process.exit );
		}
	} );
	redisClient.on( 'opened', getNewItemFromQueue );
	redisClient.connect();
	console.debug(
		'Backend worker now listening for new jobs from queue',
		{ channel: 'backend' }
	);
}

/**
 * Stops (closes) the frontend server
 *
 * @param {callback} callbackFunc - Function to call when server successfully closed
 */
function stopBackend( callbackFunc ) {
	redisClient.close();
	callbackFunc();
}

/* === Private Functions =================================================== */
/**
 * Async loop that forms the top of the job. Pulls items from Redis and
 * then starts the promise chain to bundle, render, and cleanup.
 */
function getNewItemFromQueue() {
	redisClient.blpop( config.redis.job_queue_name, 0 )
		.then( function( result ) {
			// The return, if there is one, will be [<listname>,<listitem>]
			if ( !result ) {
				throw new BackendError( 'Redis returned nil when picking up new job from queue.' );
			} else {
				console.info(
					'Got new job "%s", attempting to get status details and launching',
					result[1],
					{
						channel: 'backend',
						job: { id: result[1] }
					}
				);
				return redisClient.hget( config.redis.status_set_name, result[1] );
			}
		} )
		.catch( function( err ) {
			console.error( 'Error picking up new job from queue.', {
				channel: 'backend.error.fatal',
				error: eh.jsonify( err )
			} );
			stopBackend( process.exit );
		} )
		.then( newItemFromQueue )
		.catch ( function( err ) {
			// Catch the error here because it's likely non fatal. If this bubbled
			// up it would cause the thread to restart -- not the end of the world
			// but not desirable
			console.error( 'Unhandled error while attempting to process a metabook job', {
				channel: 'backend.error',
				error: eh.jsonify( err )
			} );
		} )
		.then( function() {
			// Start the loop again. Use setTimeout so that we don't continually grow the stack
			setTimeout( getNewItemFromQueue, 1 );
		})
		.done();
}

/**
 * Take a status object from getNewItemFromQueue and render it
 * @param {string} obj JSON string representing a job status object
 * @returns {promise}
 */
function newItemFromQueue( obj ) {
	var jobDetails;
	var metabookFile, bundleFile, renderTempDir, renderedFile;

	jobDetails = jd.fromJson( obj );
	console.info(
		'Backend worker now picking up job %s for writer %s',
			jobDetails.collectionId,
			jobDetails.writer,
		{
			channel: 'backend',
			job: { id: jobDetails.collectionId, writer: jobDetails.writer }
		}
	);

	// Save the JSON file to scratch space
	metabookFile = path.join( config.backend.temp_dir, jobDetails.collectionId + '.json' );
	return Promise.promisify( fs.writeFile )( metabookFile, JSON.stringify( jobDetails.metabook ) )
		.then( function() {
			bundleFile = path.join( config.backend.temp_dir, jobDetails.collectionId + '.zip' );
			return runBundler( jobDetails, metabookFile, bundleFile );
		} )
		.then( function() {
			renderTempDir = path.join(
				config.backend.temp_dir,
				jobDetails.collectionId + '.' + jobDetails.writer
			);
			fs.mkdirSync( renderTempDir );
			return runRenderer( jobDetails, renderTempDir, bundleFile );
		} )
		.spread( function( renderedFile, fileSize ) {
			// We have something! Create the URL and update everyone!
			var url = sprintf(
				"http://%s:%s/?command=download&collection_id=%s&writer=%s",
				config.coordinator.hostname || os.hostname(),
				config.frontend.port || '80',
				jobDetails.collectionId,
				jobDetails.writer
			);

			// Because collection is dumb we have to set the suggested file name, content size
			// and content type...
			jobDetails.updateFinished(
				renderedFile,
				url,
				mime.lookup( renderedFile ),
				jobDetails.metabook.title || jobDetails.collectionId,
				fileSize
			);
			return redisClient.hset(
				config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify( jobDetails )
			).catch( function( err ) {
				console.error( "Could not report status to client: %s", err, {
					channel: 'backend.error',
					error: eh.jsonify( err ),
					job: { id: jobDetails.collectionId, writer: jobDetails.writer }
				} );
			} );
		} )
		.catch( function( err ) {
			// Both the bundler and renderer shortcut here on error
			// Move files into a triage area for later poking at
			if ( config.backend.post_mortem_dir ) {
				if ( metabookFile ) {
					mv(
						metabookFile,
						path.join( config.backend.post_mortem_dir, path.basename( metabookFile ) ),
						{ mkdirp: true },
						function() {}
					);
				}
				if ( bundleFile ) {
					mv(
						bundleFile,
						path.join( config.backend.post_mortem_dir, path.basename( bundleFile ) ),
						{ mkdirp: true },
						function() {}
					);
				}
				if ( renderTempDir ) {
					mv(
						renderTempDir,
						path.join( config.backend.post_mortem_dir, path.basename( renderedFile ) ),
						{ mkdir: true },
						function() {}
					);
				}
				if ( renderedFile ) {
					mv(
						renderedFile,
						path.join( config.backend.post_mortem_dir, path.basename( renderedFile ) ),
						{ mkdirp: true },
						function() {}
					);
				}
			}

			// notify the user and log it
			var channel = 'backend.error';
			if ( err instanceof BundlerError ) { channel = 'backend.bundler.error'; }
			else if ( err instanceof RendererError ) { channel = 'backend.renderer.error'; }

			console.error( err.message || err, {
				channel: channel,
				job: { id: jobDetails.collectionId, writer: jobDetails.writer },
				error: eh.jsonify( err )
			} );

			jobDetails.updateError( err.message || err );
			return redisClient.hset(
				config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify( jobDetails )
			).catch( function( err ) {
				console.error( "Could not report status to client: " + err, {
					channel: 'backend.error',
					error: eh.jsonify( err ),
					job: { id: jobDetails.collectionId, writer: jobDetails.writer }
				} );
			} );
		} )
		.then( function() {
			// Cleanup any mess we left, leave the rendered file for later pickup
			if ( metabookFile ) { rimraf.sync( metabookFile ); }
			if ( bundleFile ) { rimraf.sync( bundleFile ); }
			if ( renderTempDir ) { rimraf.sync( renderTempDir ); }
		} );
}

/**
 * Process a received child process message
 *
 * @param message The message object
 * @param jobDetails The current job details context
 * @param part What child process ( bundler / renderer )
 */
function processReceivedMessage( message, jobDetails, part ) {
	var logPrefix, jdUpdateFn;
	if ( part === 'bundler' ) {
		logPrefix = 'backend.bundler.bin';
		jdUpdateFn = jobDetails.updateBundling;
	} else if ( part === 'renderer' ) {
		logPrefix = 'backend.renderer.bin';
		jdUpdateFn = jobDetails.updateRendering;
	}
	if ( message.type === 'status' ) {
		jdUpdateFn.call(
			jobDetails,
			message.file, message.message, message.percent
		);
		redisClient
			.hset( config.redis.status_set_name,
			jobDetails.collectionId,
			JSON.stringify( jobDetails )
		).catch( function ( err ) {
			console.warn( "Could not report status to client: " + err, {
				channel: logPrefix + '.error',
				error:   eh.jsonify( err ),
				job:     { id: jobDetails.collectionId, writer: jobDetails.writer }
			} );
		} );
	} else if ( message.type === 'log' ) {
		var msglevel = message.level || 'info';
		console[msglevel]( message.stack || message.message, {
			channel: logPrefix,
			job: {
				id: jobDetails.collectionId,
				writer: jobDetails.writer
			},
			details: message.details
		});
	} else {
		console.error( '%s emitted message with unknown type', part, {
			channel: logPrefix + '.error',
			job:     { id: jobDetails.collectionId, writer: jobDetails.writer },
			rxmsg:   message
		} );
	}
}

/**
 * Fork the bundler process and resolve the promise when done
 *
 * @param jobDetails
 * @param metabookPath
 * @param bundleFile
 * @returns {promise|Deferred.promise|o.A.n.promise|PromiseCapability.promise}
 */
function runBundler( jobDetails, metabookPath, bundleFile ) {
	var child, killTimer,
		startTime = Date.now(),
		p = Promise.defer();

	jobDetails.updateBundling( null, 'Launching bundler', 0 );
	redisClient.hset( config.redis.status_set_name,
		jobDetails.collectionId,
		JSON.stringify( jobDetails )
	);

	console.info( 'Forking bundler to create %s from %s', bundleFile, metabookPath, {
		channel: 'backend.bundler',
		job: { id: jobDetails.collectionId, writer: jobDetails.writer }
	} );
	child = child_process.fork(
		config.backend.bundler.bin, [
			'--no-compat',
			'-p', config.backend.bundler.parsoid_prefix,
			'-a', config.backend.bundler.parsoid_api,
			'-m', metabookPath,
			'-d', bundleFile
		].concat( config.backend.bundler.additionalArgs || [] )
	);

	child.on( 'error', function( err ) {
		if ( killTimer ) {
			clearTimeout( killTimer );
		}
		p.reject(
			new BundlerError( sprintf( 'Bundler child reported back with error: %s', err ) )
		);
	} );
	child.on( 'message', function ( message, handle ) {
		processReceivedMessage( message, jobDetails, 'bundler' );
	} );
	child.on( 'exit', function ( code, signal ) {
		if ( killTimer ) {
			clearTimeout( killTimer );
		}

		if ( code !== 0 ) {
			statsd.timing(
					'backend.bundler.time_to_failure',
					( Date.now() - startTime ) / 1000
			);

			if ( signal === 'SIGTERM' ) {
				p.reject( new BundlerError( 'Killed bundler, exceeded execution time limit' ) );
			} else {
				p.reject( new BundlerError( 'Bundling process died with non zero code: ' + code ) );
			}
		} else {
			statsd.timing(
				'backend.bundler.time_to_success',
				( Date.now() - startTime ) / 1000
			);

			console.info( 'Bundle completed successfully!', {
				channel: 'backend.bundler',
				job: { id: jobDetails.collectionId, writer: jobDetails.writer }
			} );
			p.resolve( bundleFile );
		}
	} );

	if ( config.backend.bundler.max_execution_time ) {
		killTimer = setTimeout( function() {
			console.warn( 'Killing bundler because maximum execution time exceeded.', {
				channel: 'backend.bundler',
				job: { id: jobDetails.collectionId, writer: jobDetails.writer }
			});

			if ( child.connected ) {
				child.kill( 'SIGTERM' );
			}
		}, config.backend.bundler.max_execution_time * 1000 );
	}

	return p.promise;
}

/**
 * For the appropriate renderer and resolve the promise when done
 *
 * @param jobDetails
 * @param renderTempDir
 * @param bundleFile
 * @returns {promise}
 */
function runRenderer( jobDetails, renderTempDir, bundleFile ) {
	var child, killTimer,
		startTime = Date.now(),
		writer = jobDetails.writer;

	if ( !config.backend.writers[writer] ) {
		throw new RendererError( sprintf( 'Unknown writer %s. Cannot render. ', writer ) );
	}

	var p = Promise.defer();
	var url;
	var renderFile = path.join(
		config.backend.output_dir,
		jobDetails.collectionId + config.backend.writers[writer].extension
	);

	jobDetails.updateRendering( null, 'Launching renderer', 50 );
	redisClient.hset(
		config.redis.status_set_name,
		jobDetails.collectionId,
		JSON.stringify( jobDetails )
	);

	console.info( 'Forking renderer to produce %s from %s', renderFile, bundleFile, {
		channel: 'backend.bundler',
		job: { id: jobDetails.collectionId, writer: jobDetails.writer }
	} );
	child = child_process.fork(
		config.backend.writers[writer].bin, [
			'-T', renderTempDir,
			'-o', renderFile
		].concat(
			config.backend.writers[writer].additionalArgs || [],
			bundleFile
		)
	);

	child.on( 'error', function ( err ) {
		if ( killTimer ) {
			clearTimeout( killTimer );
		}
		p.reject(
			new RendererError( sprintf ('Renderer reported back with spawn error: %s', err ) )
		);
	} );
	child.on( 'message', function ( message, handle ) {
		processReceivedMessage( message, jobDetails, 'renderer' );
	} );
	child.on( 'exit', function ( code, signal ) {
		if ( killTimer ) {
			clearTimeout( killTimer );
		}

		if ( code !== 0 ) {
			statsd.timing(
				'backend.writer.' + writer + '.time_to_failure',
				( Date.now() - startTime ) / 1000
			);

			if ( signal === 'SIGTERM' ) {
				p.reject( new BundlerError( 'Killed renderer, exceeded execution time limit' ) );
			} else {
				p.reject( new BundlerError( 'Rendering process died with non zero code: '+code ) );
			}
		} else {
			Promise.promisify( fs.stat )( renderFile )
				.then( function( result ) {
					statsd.timing(
							'backend.writer.' + writer + '.time_to_success',
							( Date.now() - startTime ) / 1000
					);

					console.info( 'Render completed successfully!', {
						channel: 'backend.renderer',
						job:     { id: jobDetails.collectionId, writer: jobDetails.writer }
					} );
					p.resolve( [ renderFile, result.size ] );
				})
				.catch( function( err ) {
					statsd.timing(
						'backend.writer.' + writer + '.time_to_failure',
						( Date.now() - startTime ) / 1000
					);
					p.reject(
						new BackendError( 'Could not stat rendered output file. Render failed!' )
					);
				} );
		}
	} );

	if ( config.backend.writers[writer].max_execution_time ) {
		killTimer = setTimeout( function() {
			console.warn( 'Killing renderer because maximum execution time exceeded.', {
				channel: 'backend.renderer',
				job: { id: jobDetails.collectionId, writer: jobDetails.writer }
			});

			if ( child.connected ) {
				child.kill( 'SIGTERM' );
			}
		}, config.backend.writers[writer].max_execution_time * 1000 );
	}

	return p.promise;
}

function BackendError( message ) {
	BackendError.super_.call( this, message );
}
util.inherits( BackendError, eh.OcgError );

function BundlerError( message ) {
	BundlerError.super_.call( this, message );
}
util.inherits( BundlerError, BackendError );

function RendererError( message ) {
	RendererError.super_.call( this, message );
}
util.inherits( RendererError, BackendError );

exports.init = initBackend;
exports.start = startBackend;
exports.stop = stopBackend;

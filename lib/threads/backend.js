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
var mime = require( 'mime' );
var path = require( 'path' );
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
	if ( !config.backend.output_dir ) {
		config.backend.output_dir = path.join( config.backend.temp_dir, 'ocg-output' );
	}

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

function newItemFromQueue( obj ) {
	var jobDetails;
	var tempMetabook, tempBundle, tempRender;

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
	tempMetabook = path.join( config.backend.temp_dir, jobDetails.collectionId + '.json' );
	return Promise.promisify( fs.writeFile )( tempMetabook, JSON.stringify( jobDetails.metabook ) )
		.then( function() {
			return runBundler( jobDetails, tempMetabook );
		} )
		.then( function( bundleFile ) {
			tempBundle = bundleFile;
			return runRenderer( jobDetails, bundleFile );
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
				if ( tempMetabook ) {
					fs.rename(
						tempMetabook,
						path.join( config.backend.post_mortem_dir, path.basename( tempMetabook ) )
					);
				}
				if ( tempBundle ) {
					fs.rename(
						tempBundle,
						path.join( config.backend.post_mortem_dir, path.basename( tempBundle ) )
					);
				}
				if ( tempRender ) {
					fs.rename(
						tempRender,
						path.join( config.backend.post_mortem_dir, path.basename( tempRender ) )
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
			// Use a null callback so that errors are not output to the console
			if ( tempMetabook ) { fs.unlink( tempMetabook, function() {} ); }
			if ( tempBundle ) { fs.unlink( tempBundle, function() {} ); }
		} );
}

function runBundler( jobDetails, metabookPath ) {
	var child;
	var bundleFile = path.join( config.backend.temp_dir, jobDetails.collectionId + '.zip' );
	var p = Promise.defer();

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
			'--syslog',
			'-p', config.backend.bundler.parsoid_prefix,
			'-a', config.backend.bundler.parsoid_api,
			'-m', metabookPath,
			'-o', bundleFile
		].concat( config.backend.bundler.additionalArgs || [] )
	);

	child.on( 'error', function( err ) {
		jobDetails.updateError( 'Could not launch bundling process' );
		redisClient.hset( config.redis.status_set_name,
			jobDetails.collectionId,
			JSON.stringify( jobDetails )
		).catch(function( err ) {
			console.warn( "Could not report failure to client: " + err, {
				channel: 'backend.bundler.error',
				error: eh.jsonify( err ),
				job: { id: jobDetails.collectionId, writer: jobDetails.writer }
			} );
		} );

		p.reject(
			new BundlerError( sprintf( 'Bundler child reported back with error: %s', err ) )
		);
	} );
	child.on( 'message', function ( message, handle ) {
		jobDetails.updateBundling( message.file, message.status, message.percent );
			redisClient
				.hset( config.redis.status_set_name,
					jobDetails.collectionId,
					JSON.stringify( jobDetails )
				)
				.catch(function( err ) {
					console.warn( "Could not report status to client: " + err, {
						channel: 'backend.bundler.error',
						error: eh.jsonify( err ),
						job: { id: jobDetails.collectionId, writer: jobDetails.writer }
					} );
				} );
	} );
	child.on( 'exit', function ( code, signal ) {
		if ( code !== 0 ) {
			jobDetails.updateError( 'Bundler process died unexpectedly' );
			redisClient
				.hset(
					config.redis.status_set_name,
					jobDetails.collectionId,
					JSON.stringify( jobDetails )
				)
				.catch( function( err ) {
					console.warn( "Could not report status to client: " + err, {
						channel: 'backend.bundler.error',
						error: eh.jsonify( err ),
						job: { id: jobDetails.collectionId, writer: jobDetails.writer }
					} );
				} );
			p.reject( new BundlerError( 'Bundling process died with non zero code: ' + code ) );
		} else {
			console.info( 'Bundle completed successfully!', {
				channel: 'backend.bundler',
				job: { id: jobDetails.collectionId, writer: jobDetails.writer }
			} );
			p.resolve( bundleFile );
		}
	} );

	return p.promise;
}

function runRenderer( jobDetails, bundleFile ) {
	var child,
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
			'--syslog',
			'-o', renderFile
		].concat(
			config.backend.writers[writer].additionalArgs || [],
			bundleFile
		)
	);

	child.on( 'error', function ( err ) {
		jobDetails.updateError( 'Could not launch rendering process' );
		redisClient
			.hset( config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify( jobDetails )
			)
			.catch(function( err ) {
				console.warn( "Could not report failure to client: " + err, {
					channel: 'backend.renderer.error',
					error: eh.jsonify( err ),
					job: { id: jobDetails.collectionId, writer: jobDetails.writer }
				} );
			} );
		p.reject(
			new RendererError( sprintf ('Renderer reported back with spawn error: %s', err ) )
		);
	} );
	child.on( 'message', function ( message, handle ) {
		jobDetails.updateRendering( message.file, message.status, message.percent );
		redisClient
			.hset( config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify( jobDetails )
			)
			.catch( function( err ) {
				console.warn( "Could not report status to client: " + err, {
					channel: 'backend.renderer.error',
					error: eh.jsonify( err ),
					job: { id: jobDetails.collectionId, writer: jobDetails.writer }
				} );
			} );
	} );
	child.on( 'exit', function ( code, signal ) {
		if ( code !== 0 ) {
			jobDetails.updateError( 'Render process died unexpectedly' );
			redisClient
				.hset(
					config.redis.status_set_name,
					jobDetails.collectionId,
					JSON.stringify( jobDetails )
				)
				.catch( function ( err ) {
					console.warn( "Could not report status to client: " + err, {
						channel: 'backend.renderer',
						error:   eh.jsonify( err ),
						job:     { id: jobDetails.collectionId, writer: jobDetails.writer }
					} );
				} );
			p.reject( new RendererError( 'Rendering process died with non zero code: ' + code ) );
		} else {
			Promise.promisify( fs.stat )( renderFile )
				.then( function( result ) {
					console.info( 'Render completed successfully!', {
						channel: 'backend.renderer',
						job:     { id: jobDetails.collectionId, writer: jobDetails.writer }
					} );
					p.resolve( [ renderFile, result.size ] );
				})
				.catch( function( err ) {
					p.reject(
						new BackendError( 'Could not stat rendered output file. Render failed!' )
					);
				} );
		}
	} );

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

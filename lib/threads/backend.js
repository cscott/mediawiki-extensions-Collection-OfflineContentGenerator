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

require( 'core-js/shim' );
var Promise = require( 'prfun' );

var child_process = require( 'child_process' );
var eh = require( '../errorhelper.js' );
var fs = require( 'fs' );
var mkdirp = Promise.promisify( require( 'mkdirp' ) );
mkdirp.sync = require( 'mkdirp' ).sync;
var mime = require( 'mime' );
var mv = Promise.promisify( require('mv') );
var path = require( 'path' );
var rimraf = Promise.promisify( require( 'rimraf' ) );
var os = require( 'os' );
var util = require( 'util' );

var jd = require( '../JobDetails.js' );
var Redis = require( '../RedisWrapper.js' );

var config = null;
var redisClient = null;

/* === Public Exported Functions =========================================== */
/**
 * Set up the default temporary and output directories.
 *
 * @param {hash} config - Configuration object
 */
function initDirectories( config ) {

	if ( !config.backend.temp_dir ) {
		if ( os.tmpdir ) {
			config.backend.temp_dir = path.join( os.tmpdir(), 'ocg' );
		} else {
			// Node < 0.10
			config.backend.temp_dir = path.join( os.tmpDir(), 'ocg' );
		}
	}
	// create the temp dir if necessary
	mkdirp.sync(config.backend.temp_dir);

	if ( !config.backend.output_dir ) {
		config.backend.output_dir = path.join( config.backend.temp_dir, 'ocg-output' );
	}
	// create the output directory if necessary
	mkdirp.sync(config.backend.output_dir);

	return config;
}

/**
 * Initialize the frontend server with global objects
 *
 * @param {hash} config_obj - Configuration object
 */
function initBackend( config_obj ) {
	var writer, paths;

	config = initDirectories( config_obj );

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
				err: err
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
				err: err
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
	var jobDetails, host;
	var metabookFile, bundleFile, renderTempDir, renderedFile;

	jobDetails = jd.fromJson( obj );
	host = jobDetails.host = config.coordinator.hostname || os.hostname();

	console.info(
		'Backend worker on %s now picking up job %s for writer %s',
		host,
		jobDetails.collectionId,
		jobDetails.writer,
		{
			channel: 'backend',
			job:     {
				id: jobDetails.collectionId,
				writer: jobDetails.writer,
				// stringify metabook so logstash doesn't break this into
				// individual fields!
				// Caution: this may cause logstash (or UDP) to drop this
				// message if the metabook is very large.
				metabook: JSON.stringify( jobDetails.metabook, null, 2 )
			}
		}
	);

	// Save the JSON file to scratch space
	metabookFile = path.join( config.backend.temp_dir, jobDetails.collectionId + '.json' );
	return Promise.promisify( fs.writeFile, false, fs )( metabookFile, JSON.stringify( jobDetails.metabook, null, 2 ) )
		.then( function() {
			bundleFile = path.join( config.backend.temp_dir, jobDetails.collectionId + '.zip' );
			return runBundler( jobDetails, metabookFile, bundleFile );
		} )
		.then( function() {
			renderTempDir = path.join(
				config.backend.temp_dir,
				jobDetails.collectionId
			);
			return Promise.promisify( fs.mkdir, false, fs )( renderTempDir ).
				then(function() {
					return runRenderer( jobDetails, renderTempDir, bundleFile );
				});
		} )
		.spread( function( renderedFile, fileSize ) {
			// We have something! Create the URL and update everyone!
			var url = util.format(
				"http://%s:%s/?command=download_file&collection_id=%s&writer=%s",
				host,
				config.frontend.port || '80',
				jobDetails.collectionId,
				jobDetails.writer
			);

			// Because collection is dumb we have to set the suggested file name, content size
			// and content type...
			var mimeType = ( config.backend.writers[ jobDetails.writer ] &&
				config.backend.writers[ jobDetails.writer ].mimeType ) ||
				mime.lookup( renderedFile );
			var extension = ( config.backend.writers[ jobDetails.writer ] &&
				config.backend.writers[ jobDetails.writer ].extension ) ||
				( '.' + mime.extension( mimeType ) );
			// use given title, or title of first item, or else collection id
			var title = jobDetails.metabook.title ||
				( jobDetails.metabook.items.length === 1 && jobDetails.metabook.items[0].title ) ||
				jobDetails.collectionId;
			jobDetails.updateFinished(
				renderedFile,
				url,
				mimeType,
				title + extension,
				fileSize
			);
			statsd.timing(
				'backend.total.' + jobDetails.writer + '.time_to_success',
				(jobDetails.job_end - jobDetails.job_start) / 1000
			);
			return redisClient.hset(
				config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify( jobDetails )
			).catch( function( err ) {
				console.error( "Could not report status to client: %s", err, {
					channel: 'backend.error',
					err: err,
					job: { id: jobDetails.collectionId, writer: jobDetails.writer }
				} );
			} );
		} )
		.catch( function( err ) {
			// Both the bundler and renderer shortcut here on error
			// Move files into a triage area for later poking at
			var tasks = [];
			if ( config.backend.post_mortem_dir ) {
				if ( metabookFile ) {
					tasks.push( mv(
						metabookFile,
						path.join( config.backend.post_mortem_dir, path.basename( metabookFile ) ),
						{ mkdirp: true }
					) );
				}
				if ( bundleFile ) {
					tasks.push( mv(
						bundleFile,
						path.join( config.backend.post_mortem_dir, path.basename( bundleFile ) ),
						{ mkdirp: true }
					) );
				}
				if ( renderTempDir ) {
					tasks.push( mv(
						renderTempDir,
						path.join( config.backend.post_mortem_dir, path.basename( renderTempDir ) ),
						{ mkdirp: true }
					) );
				}
				if ( renderedFile ) {
					tasks.push( mv(
						renderedFile,
						path.join( config.backend.post_mortem_dir, path.basename( renderedFile ) ),
						{ mkdirp: true }
					) );
				}
				// Ignore any errors moving files into post mortem
				tasks = tasks.map(function(p) {
					return p.catch(function(err) { /* ignore */ });
				});
			}

			// notify the user and log it
			var channel = 'backend.error';
			if ( err instanceof BundlerError ) { channel = 'backend.bundler.error'; }
			else if ( err instanceof RendererError ) { channel = 'backend.renderer.error'; }

			console.error( err.message || (''+err), {
				channel: channel,
				job: { id: jobDetails.collectionId, writer: jobDetails.writer },
				err: err
			} );

			jobDetails.updateError( err.message || err );
			return redisClient.hset(
				config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify( jobDetails )
			).catch( function( err ) {
				console.error( "Could not report status to client: %s", err, {
					channel: 'backend.error',
					err: err,
					job: { id: jobDetails.collectionId, writer: jobDetails.writer }
				} );
			} ).then(function() {
				// make sure postmortem moves complete before we try to
				// clean up below
				return Promise.all(tasks);
			});
		} )
		.then( function() {
			// Cleanup any mess we left, leave the rendered file for later pickup
			return Promise.join(
				metabookFile ? rimraf( metabookFile ) : null,
				bundleFile ? rimraf( bundleFile ) : null,
				renderTempDir ? rimraf( renderTempDir ) : null
			);
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
			console.warn( "Could not report status to client: %s", err, {
				channel: logPrefix + '.error',
				err:     err,
				job:     { id: jobDetails.collectionId, writer: jobDetails.writer }
			} );
		} );
	} else if ( message.type === 'log' ) {
		var msglevel = message.level || 'info';
		console[msglevel]( message.stack || message.message || '<no message>', {
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
 * Fork a process and return a promise for its completion.  A maximum
 * execution time (`options.timeout`, in milliseconds) and a message
 * handler (`options.messageHandler(message, handler)`) can be defined
 * in the options.  The promise is rejected if it returns a non-zero
 * exit code, if the fork fails, or if the process times out.  (The
 * process timing out is indicated by a callback to
 * `options.timeoutNotify` and by the `timeout` property being set to
 * `true` on the Error value of the rejected promise.)
 */
// Candidate for moving to mw-ocg-common/p.js
var fork = function( bin, args, options ) {
	return new Promise( function( resolve, reject ) {
		if ( options===undefined ) { options = {}; }
		var killTimer = null, killed = false;
		var clearKillTimer = function() {
			if ( killTimer ) {
				clearTimeout( killTimer );
				killTimer = null;
			}
		};
		var child = child_process.fork( bin, args, options.childOptions || {} );
		child.on( 'error', function( err ) {
			clearKillTimer();
			reject(err);
		});
		child.on( 'exit', function( code, signal ) {
			clearKillTimer();
			if ( code === 0 ) {
				return resolve();
			}
			var e = new Error( "Fork failed" );
			e.code = code;
			e.signal = signal;
			e.timeout = ( signal === 'SIGTERM' || signal === 'SIGKILL' ) && killed;
			return reject( e );
		});
		if ( options.messageHandler ) {
			child.on( 'message', options.messageHandler );
		}
		if ( options.timeout ) {
			killTimer = setTimeout( function() {
				killTimer = null;
				if ( child.connected ) {
					killed = true;
					child.kill( 'SIGTERM' );
					killTimer = setTimeout(function() {
						child.kill( 'SIGKILL' );
						killTimer = null;
					}, options.timeout * 2);
					if ( options.timeoutNotify ) {
						options.timeoutNotify();
					}
				}
			}, options.timeout );
		}
	});
};

/**
 * Create path (with some directory components derived from the filename)
 * and return an object with the desired filename, plus a 'touch' operation
 * to create any needed directory components and signal the disk usage
 * cache to recompute the directory's size.
 */
function mkFilename( dir, collectionId, extension ) {
	if (collectionId.length < 3) {
		dir = path.join( dir, 'xx' );
	} else {
		dir = path.join( dir, collectionId.slice(0, 2) );
		collectionId = collectionId.slice(2);
	}
	var utimes = Promise.promisify( fs.utimes, false, fs );
	return {
		name: path.join( dir, collectionId + extension ),
		touch: Promise.method( function() {
			return mkdirp( dir ).then(function() {
				// Note that utimes takes unix-style timestamps (ie, seconds
				// with fractional milliseconds), not JS-style timestamps!
				// But it will also accept a JS Date object, which is
				// less confusing than dividing by 1000 here. (IMO)
				var now = new Date();
				return utimes( dir, now, now );
			});
		})
	};
}

/**
 * Fork the bundler process and resolve the promise when done
 *
 * @param jobDetails
 * @param metabookPath
 * @param bundleFile
 * @returns {Promise}
 */
function runBundler( jobDetails, metabookPath, bundleFile ) {
	var startTime = Date.now();

	jobDetails.updateBundling( null, 'Launching bundler', 0 );
	redisClient.hset( config.redis.status_set_name,
		jobDetails.collectionId,
		JSON.stringify( jobDetails )
	);

	console.info( 'Forking bundler to create %s from %s', bundleFile, metabookPath, {
		channel: 'backend.bundler',
		job: { id: jobDetails.collectionId, writer: jobDetails.writer }
	} );
	var opts = [
		'-m', metabookPath,
		'-d', bundleFile
	];
	if (config.backend.bundler.restbase_api) {
		opts.push('--restbase-api', config.backend.bundler.restbase_api);
	}
	if (config.backend.bundler.parsoid_prefix) {
		opts.push('--prefix', config.backend.bundler.parsoid_prefix);
	}
	if (config.backend.bundler.parsoid_api) {
		opts.push('--parsoid-api', config.backend.bundler.parsoid_api);
	}
	opts = opts.concat(config.backend.bundler.additionalArgs || []);
	return fork(
		config.backend.bundler.bin, opts, {
			messageHandler: function( message ) {
				processReceivedMessage( message, jobDetails, 'bundler' );
			},
			timeout: config.backend.bundler.max_execution_time * 1000,
			timeoutNotify: function() {
				console.warn( 'Killing bundler because maximum execution time exceeded.', {
					channel: 'backend.bundler',
					job: { id: jobDetails.collectionId, writer: jobDetails.writer },
					timeout_secs: config.backend.bundler.max_execution_time
				});
			}
		}).catch(function(err) {
			if ( err.timeout ) {
				throw new BundlerError( 'Killed bundler, exceeded execution time limit' );
			} else if ( err.code ) {
				throw new BundlerError( 'Bundling process died with non zero code: ' + err.code );
			} else {
				throw new BundlerError( util.format( 'Bundler reported back with spawn error: %s', err ) );
			}
		}).then(function() {

			console.info( 'Bundle completed successfully!', {
				channel: 'backend.bundler',
				job: { id: jobDetails.collectionId, writer: jobDetails.writer }
			} );

			return bundleFile;

		}).then(function(v) {
			statsd.timing(
				'backend.bundler.time_to_success',
				( Date.now() - startTime ) / 1000
			);
			return v;
		}, function(err) {
			statsd.timing(
				'backend.bundler.time_to_failure',
				( Date.now() - startTime ) / 1000
			);
			throw err;
		});
}

/**
 * Fork the appropriate renderer and resolve the promise when done
 *
 * @param jobDetails
 * @param renderTempDir
 * @param bundleFile
 * @returns {promise}
 */
function runRenderer( jobDetails, renderTempDir, bundleFile ) {
	var startTime = Date.now(),
		writer = jobDetails.writer;

	if ( !config.backend.writers[writer] ) {
		throw new RendererError( util.format( 'Unknown writer %s. Cannot render. ', writer ) );
	}

	var url;
	var renderFile = mkFilename(
		config.backend.output_dir,
		jobDetails.collectionId,
		config.backend.writers[writer].extension
	);

	jobDetails.updateRendering( null, 'Launching renderer', 0 );
	return Promise.join(
		redisClient.hset(
			config.redis.status_set_name,
			jobDetails.collectionId,
			JSON.stringify( jobDetails )
		),
		renderFile.touch()
	).then(function() {

		console.info( 'Forking renderer to produce %s from %s', renderFile.name, bundleFile, {
			channel: 'backend.bundler',
			job: { id: jobDetails.collectionId, writer: jobDetails.writer }
		} );

		var env = {};
		// Minimal secure environment; see `man 5 sudoers`
		['TERM','PATH','HOME','MAIL','SHELL','LOGNAME','USER','USERNAME'].
			forEach(function(varname) {
				env[varname] = process.env[varname];
			});
		// Set TMPDIR for any calls to mktemp() in the renderer.
		env.TMPDIR = renderTempDir;

		var latexErr;
		return fork(
			config.backend.writers[writer].bin, [
				'-T', renderTempDir,
				'-o', renderFile.name
			].concat(
				config.backend.writers[writer].additionalArgs || [],
				bundleFile
			), {
				childOptions: { env: env },
				messageHandler: function( message ) {
					processReceivedMessage( message, jobDetails, 'renderer' );
					if ( message.type === 'log' && message.level === 'error' && message.details ) {
						// Try to capture the Latex error.
						var match = ( message.details.err || message.details.log || "" ).match(/\n(! .*)\n/);
						if ( match ) {
							latexErr = match[1];
						}
					}
				},
				timeout: config.backend.writers[writer].max_execution_time * 1000,
				timeoutNotify: function() {
					console.warn( 'Killing renderer because maximum execution time exceeded.', {
						channel: 'backend.renderer',
						job: { id: jobDetails.collectionId, writer: jobDetails.writer },
						timeout_secs: config.backend.writers[writer].max_execution_time
					});
				}
			}).catch(function(err) {
				if ( err.timeout ) {
					throw new RendererError( 'Killed renderer, exceeded execution time limit' );
				} else if ( latexErr ) {
					throw new RendererError( latexErr );
				} else if ( err.code ) {
					throw new RendererError( 'Rendering process died with non zero code: ' + err.code );
				} else {
					throw new RendererError( util.format( 'Renderer reported back with spawn error: %s', err ) );
				}
			});
	}).then(function() {
		return renderFile.touch();
	}).then(function() {
		return Promise.promisify( fs.stat, false, fs )( renderFile.name ).
			catch(function(err) {
				throw new BackendError( util.format('Could not stat rendered output file. Render failed!', renderFile.name, err ) );
			});
	}).then(function(stat) {
		console.info( 'Render completed successfully!', {
			channel: 'backend.renderer',
			job:     { id: jobDetails.collectionId, writer: jobDetails.writer }
		} );
		return [ renderFile.name, stat.size ];
	}).then(function(v) {
		statsd.timing(
			'backend.writer.' + writer + '.time_to_success',
			( Date.now() - startTime ) / 1000
		);
		return v;
	}, function(err) {
		statsd.timing(
			'backend.writer.' + writer + '.time_to_failure',
			( Date.now() - startTime ) / 1000
		);
		throw err;
	});
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
exports.initDirectories = initDirectories;
exports.start = startBackend;
exports.stop = stopBackend;

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

var Busboy = require( 'busboy' );
var child_process = require( 'child_process' );
var crypto = require( 'crypto' );
var fs = require( 'fs' );
var http = require( 'http' );
var path = require( 'path' );
var url = require( 'url' );
var util = require( 'util' );

var package_json = require( '../../package.json' );
var jd = require( '../JobDetails.js' );
var Redis = require( '../RedisWrapper.js' );

var config = null;
var eh = require( '../errorhelper.js' );
var redisClient = null;
var started = false;
var server = null;
var sprintf = require( 'sprintf-js' ).sprintf;
var getFolderSize; // forward declaration

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
	server = http.createServer( decodeRequest );
}

/**
 * Starts the frontend server
 */
function startServer() {
	var socket = config.frontend.socket;
	var port = config.frontend.port;
	var address = config.frontend.address;

	var loop = false;
	redisClient.on( 'closed', function () {
		if ( !loop ) {
			loop = true;
			console.error( 'Frontend connection to redis died, killing thread.', {
				channel: 'frontend.error.fatal'
			} );
			stopServer( process.exit );
		}
	} );
	redisClient.connect();

	function onListening() {
		console.debug( 'Frontend server reporting for duty on previously reported mechanism', {
			channel: 'frontend'
		} );
		started = true;
	}

	server.on( 'error', function ( err ) {
		console.error( 'Unexpected HTTP server error (terminating thread): %s', err, {
			channel: 'frontend.error.fatal',
			err: err
		} );
		stopServer( process.exit );
	} );

	if ( socket ) {
		console.info( 'Frontend server starting on unix socket "%s"', socket, {
			channel: 'frontend'
		} );
		server.listen( socket, onListening );
	} else if ( port ) {
		console.info(
			'Frontend server starting on %s, port %s',
			address ? address : 'all IP interfaces',
			port,
			{ channel: 'frontend' }
		);
		server.listen( port, address, onListening );
	} else {
		console.error( 'Frontend could not start, no server parameters specified', {
			channel: 'frontend.error.fatal'
		} );
		process.abort();
	}
}

/**
 * Stops (closes) the frontend server
 *
 * @param callbackFunc Function to call when server successfully closed
 */
function stopServer( callbackFunc ) {
	redisClient.close();
	if ( started ) {
		server.close( callbackFunc );
	} else {
		console.debug( "Frontend requested to stop, but it never started.", {
			channel: 'frontend'
		});
		callbackFunc();
	}
}

/* === Private Functions =================================================== */
/**
 * Command dispatcher.
 * server.request callback.
 *
 * Subfunctions are expected to handle the entire request (including calling
 * response.end()) unless they throw a FrontendError. In which case this
 * function will write out the details and close the connection.
 *
 * This function may end the entire thread if an error cannot be handled.
 *
 * @param request http.IncomingMessage
 * @param response http.ServerResponse
 */
function decodeRequest( request, response ) {
	var time = Date.now();

	request.id = sprintf( "%d-%05d", Date.now(), Math.random() * 99999 );
	console.info(
		"Starting request %s for %s, HTTP %s %s %s",
		request.id, request.socket.address().address,
		request.httpVersion, request.method, request.url,
		{
			channel: 'frontend.request',
			request: {
				id: request.id,
				clientip: request.socket.address().address,
				version: request.httpVersion,
				method: request.method,
				url: request.url
			}
		}
	);

	// Wrap the request handling in a promise so that we can 'gracefully' use
	// the busboy event driver and still handle exceptions
	var p = new Promise( function( resolve, reject ) {
		var args = {};

		if ( request.method === 'POST' ) {
			var busboy = new Busboy( {
				headers:   request.headers,
				fieldSize: 10 * 1024 * 1024 // 10 MB
			} );
			var continueRequest = true;

			busboy.on( 'field', function ( field, value, valTruncated, keyTruncated ) {
				if ( valTruncated ) {
					continueRequest = false;
					reject( new FrontendError(
						'Field ('+field+') truncated when parsing POST. Maximum length is 10MB.',
						413
					) );
				} else {
					args[field] = value;
				}
			} );
			busboy.on( 'end', function () {
				if ( continueRequest ) {
					resolve( args );
				} else {
					reject( new FrontendError( 'At busboy end, but cannot continue' ) );
				}
			} );

			request.pipe( busboy );

		} else if ( request.method === 'GET' ) {
			args = url.parse( request.url, true ).query;
			// handle three special paths:
			// the favicon, the top-level help page, and a version report
			if ( request.url === '/' ) {
				args = { command: 'help' };
			} else if ( request.url === '/favicon.ico' ) {
				args = { command: 'favicon' };
			} else if ( request.url === '/_version' ) {
				args = { command: 'version' };
			}
			resolve( args );

		} else {
			statsd.increment( 'frontend.requests.malformed' );
			reject( new FrontendError(
				"Unrecognized HTTP verb. Only GET and POST are supported.", 405
			) );
		}
	} )
	.then( function( args ) {
		var time = Date.now();
		return handleRequest( request.id, args, response )
			.then( function() {
				statsd.timing(
					'frontend.requests.' + args.command + '.response_time',
					( Date.now() - time ) / 1000
				);
			});
	} )
	.catch( function( err ) {
		statsd.increment( 'frontend.request_errors' );
		if ( err instanceof FrontendError ) {
			console.error( err.message || (''+err), {
				request: { id: request.id },
				err: err
			} );
			response.writeHead( err.code || 500, JSON.stringify( {
				channel: 'frontend.error',
				request: { id: request.id },
				error: { message: err.message || (''+err) }
			} ) );
			response.end();
		} else {
			console.error( "Unexpected error, killing thread: %s", err, {
				channel: 'frontend.error.fatal',
				request: { id: request.id },
				err: err
			} );
			response.writeHead( 500, JSON.stringify( {
				request: { id: request.id },
				error: { message: "Unexpected server error" }
			} ) );
			response.end();
			server.close( function () {
				process.exit( 1 );
			} );
		}
	} )
	.then( function() {
		statsd.timing( 'frontend.requests.decode_and_handle', Date.now() - time );
	} );
}

/**
 * Handle a HTTP request with decoded arguments.
 *
 * @param {string} requestId - Unique ID for this request for logging
 * @param {hash} args Dictionary of combined GET/POST parameters
 * @param {http.ServerResponse} response
 */
function handleRequest( requestId, args, response ) {
	console.debug( 'Request details for %s', requestId, {
		channel: 'frontend.request.details',
		request: {
			id: requestId,
			params: args
		}
	} );
	statsd.increment( 'frontend.requests.' + args.command );

	switch ( args.command ) {
		case 'version':
			return handleVersion( requestId, args, response );
		case 'favicon':
			return handleFavicon( requestId, args, response );
		case 'health':
			return handleHealthCheck( requestId, args, response );
		case 'help':
			return handleHelp( requestId, args, response );
		case 'render':
			return handleRender( requestId, args, response );
		case 'render_status':
			return handleRenderStatus( requestId, args, response );
		case 'download':
			/* Collection extension actually expects a JSON response
			 * here, giving metadata about the download.  In normal
			 * use this command should be unused, but it is sometimes
			 * invoked on error paths.  But treat this the same as
			 * the `download_file` command for transition purposes. */
			return handleDownloadFile( requestId, args, response );
		case 'download_file':
			return handleDownloadFile( requestId, args, response );
		default:
			throw new FrontendError( util.format( 'Unrecognized command: %s', args.command ), 400 );
	}
}

/**
 * Report current server version, based on package.json and git hash.
 * Implementation borrowed from Parsoid.
 */
var versionCache;
function handleVersion( requestId, args, response ) {
	if (!versionCache) {
		versionCache = Promise.resolve({
			name: package_json.name,
			version: package_json.version
		}).then(function( v ) {
			return Promise.promisify(
				child_process.execFile, [ 'stdout', 'stderr' ], child_process
			)( 'git', [ 'rev-parse', 'HEAD' ], {
				cwd: path.join(__dirname, '..', '..' )
			}).then(function( out ) {
				v.sha = out.stdout.slice(0, -1);
				return v;
			}, function( err ) {
				/* ignore the error, maybe this isn't a git checkout */
				return v;
			});
		});
	}
	return versionCache.then(function(v) {
		response.writeHead(200, {
			'Content-Type': 'text/json'
		});
		response.end(JSON.stringify(v), 'utf8');
	});
}

/**
 * Don't pollute the logs with favicon requests.
 */
function handleFavicon( requestId, args, response ) {
	return Promise.resolve().then(function() {
		response.writeHead( 404, "No favicon implemented" );
		response.end();
	});
}

/**
 * Return a friendly help page.
 */
function handleHelp( requestId, args, response ) {
	return Promise.promisify( fs.readFile, false, fs )(
		path.join( __dirname, 'help.html' ), 'utf-8'
	).then(function(helpfile) {
		response.writeHead(200, {
			'Content-Type': 'text/html'
		});
		response.end(helpfile, 'utf8');
	});
}

/**
 * Return health parameters, we're OK if the frontend is responsive
 * but we also want to know the length of the queue
 *
 * @param response
 */
function handleHealthCheck( requestId, args, response ) {
	var start = Date.now();
	var responseAry = {
		'host': config.coordinator.hostname,
		'directories': {
			'temp': { path: config.backend.temp_dir, size: 0 },
			'output': { path: config.backend.output_dir, size: 0 },
			'postmortem': { path: config.backend.post_mortem_dir, size: 0 }
		}
	};

	var resolveSize = function ( node ) {
		return getFolderSize( node.path ).then( function( size ) {
			node.size = size;
			return node;
		} );
	};

	if (args.nocache) {
		// empty the folder size cache before computing folder size
		getFolderSize.clearCache();
	}
	return Promise.resolve().then(function() {
		if ( !args.du ) {
			// computing folder size is expensive, even when cached
			// so don't do it unless explicitly requested
			return;
		}
		return Promise.all( [
			resolveSize( responseAry.directories.temp ),
			resolveSize( responseAry.directories.output ),
			resolveSize( responseAry.directories.postmortem ),
		] ).then( function() {
			getFolderSize.gc();
		} );
	} ).then( function() {
		return redisClient.llen( config.redis.job_queue_name );
	} ).then( function( len ) {
		responseAry.JobQueue = {
			name: config.redis.job_queue_name,
			length: len
		};
	} ).then( function() {
		return redisClient.hlen( config.redis.status_set_name );
	} ).then( function( len ) {
		responseAry.StatusObjects = {
			name: config.redis.status_set_name,
			length: len
		};
	} ).then( function() {
		// Add a time to the response so we know it's current
		responseAry.time = Date.now();
		// keep an eye on how long it takes to compute our health info
		responseAry.requestTime = responseAry.time - start;
		response.writeHead( 200, "OK" );
		response.write( JSON.stringify( responseAry ) );
		response.end();
	} ).then( function() {
		statsd.gauge( 'job_queue_length', responseAry.JobQueue.length );
		statsd.gauge( 'status_objects', responseAry.StatusObjects.length );
	} ).catch( function( err ) {
		console.error(
			'Health failed with error: %s',
			err,
			{
				channel: 'frontend.error',
				err: err,
				request: { id: requestId }
			}
		);
		throw new FrontendError( 'Status check failed (redis failure?)', 500 );
	} );
}

/**
 * Handle injecting a render job (command=render)
 *
 * @param {string} requestId - Unique ID for this request for logging
 * @param {hash} args - URL parameters
 * @param {http.ServerResponse} response
 */
function handleRender( requestId, args, response ) {
	var collectionId = args.collection_id;
	var metabook = args.metabook;
	var metabookObj = {};
	var writer = args.writer;
	var forceRender = args.force_render || false;
	var isCached = false;
	var multi = null;

	if ( !writer || ( typeof writer !== 'string' ) ) {
		throw new FrontendError(
			'Cannot begin "render" command: parameter "writer" not specified',
			400
		);
	}

	// aliases for writers (used for mwlib compatibility)
	if ( config.backend.writer_aliases[ writer ] ) {
		writer = config.backend.writer_aliases[ writer ];
	}

	// sanity-check writer
	if ( !( config.backend.writers[ writer ] && config.backend.writers[ writer ].bin ) ) {
		throw new FrontendError(
			'Bad writer',
			400
		);
	}

	if ( !collectionId ) {
		// Create the SHA hash of this collection request
		if ( !metabook ) {
			throw new FrontendError(
				'Cannot begin "render" command: parameter "metabook" not specified',
				400
			);
		} else {
			metabookObj = JSON.parse( metabook );
			if ( !metabookObj ) {
				throw new FrontendError(
					'Cannot begin "render" command: parameter "metabook" not valid JSON',
					400
				);
			}
			collectionId = createCollectionId( metabookObj, writer );
		}
	}

	var determineCachedStatus = Promise.method( function() {
		var jobDetails;

		return redisClient.hget( config.redis.status_set_name, collectionId )
			.then( function( result ) {
				if ( result ) {
					jobDetails = jd.fromJson( result );
					if ( !metabook ) {
						metabookObj = jobDetails.metabook;
					}
					console.debug( 'Checked cache status for collection %s, status: %s',
						collectionId,
						jobDetails.state,
						{
							channel: 'frontend',
							request: { id: requestId },
							job: { id: collectionId }
						}
					);
					// success == cached job, unless we want to force render
					if ( jobDetails.state === 'finished' ) {
						return !forceRender;
					}
					// don't retry failed jobs if we've configured a lockout
					// and they're in it
					var jobAge = Date.now() - jobDetails.timestamp; /* ms */
					if ( jobAge < (config.frontend.failed_job_lockout_time * 1000) ) {
						return true;
					}
				}
				return false;
			} )
			.catch( function( err ) {
				console.error(
					'Could not obtain cache status about collection: %s',
					collectionId,
					err,
					{
						channel: 'frontend.error',
						err: err,
						request: { id: requestId },
						job: { id: collectionId }
					}
				);
			} );
	} );

	/**
	 * Check the length of the job queue to determine if we can accept a new job
	 * @returns {bool|Promise}
	 */
	var canIRender = Promise.method( function() {
		if ( config.redis.max_job_queue_length ) {
			return redisClient
				.llen( config.redis.job_queue_name )
				.then( function( len ) {
					console.debug( 'Checked job length and it is: %s', len, {
						channel: 'frontend',
						request: { id: requestId },
						job: { id: collectionId }
					} );
					statsd.gauge( 'job_queue_length', len );
					return len <= config.redis.max_job_queue_length;
				} );
		} else {
			return true;
		}
	} );

	function addRenderJob() {
		return Promise.resolve( ( function() {
			// Shove a new job into redis
			console.info( 'Adding job with id %s to redis for %s', collectionId, requestId, {
				channel: 'frontend',
				request: { id: requestId },
				job: { id: collectionId }
			} );
			multi = redisClient.multi();
			multi.rpush( config.redis.job_queue_name, collectionId );
			multi.hset(
				config.redis.status_set_name,
				collectionId,
				new jd.JobDetails(
					collectionId,
					metabookObj,
					writer
				).toJson()
			);
			return Promise.promisify( multi.exec, false, multi )().catch( function( err ) {
				console.error(
					'Job insertion into redis failed for job %s with error: %s',
					collectionId,
					err,
					{
						channel: 'frontend.error',
						err: err,
						request: { id: requestId },
						job: { id: collectionId }
					}
				);
				throw new FrontendError( 'Job insertion failed (redis failure?)', 500 );
			});
		}() ) );
	}

	return determineCachedStatus().then( function( cacheStatus ) {
			isCached = cacheStatus;
			if ( !isCached ) {
				return canIRender().then( function( canRender )  {
						if ( canRender ) {
							return addRenderJob();
						} else {
							console.warn( 'Refusing new job because job queue is full', {
								channel: 'frontend',
								request: { id: requestId },
								job: { id: collectionId }
							} );
							throw new FrontendError( 503, 'Job queue is full.' );
						}
					} );
			} else {
				statsd.increment( 'frontend.requests.render.cached' );
			}
		})
		.then( function() {
			response.write( JSON.stringify( {
				collection_id: collectionId,
				writer:        writer,
				is_cached:     isCached
			} ) );
			response.end();
		} );
}

function handleRenderStatus( requestId, args, response ) {
	var collectionId = args.collection_id;

	if ( !collectionId ) {
		throw new FrontendError( 'Collection ID must be given to query render status.', 400 );
	}

	console.debug(
		'Attempting to obtain render status for collection id %s',
		collectionId,
		{
			channel: 'frontend',
			request: { id: requestId },
			job: { id: collectionId }
		}
	);

	return redisClient.hget( config.redis.status_set_name, collectionId )
		.then( function ( result ) {
			if ( !result ) {
				console.debug( 'Could not find key with id %s in redis', collectionId, {
					channel: 'frontend',
					request: { id: requestId },
					job: { id: collectionId }
				} );
				throw new FrontendError( 'CollectionID not found', 404 );
			} else {
				console.debug( 'Fetched object from redis by key %s', collectionId, {
					channel: 'frontend',
					request: { id: requestId },
					job: { id: collectionId }
				} );
				response.write( result );
			}
			response.end();
		} )
		.catch( function ( err ) {
			console.error( 'Redis error whilst fetching id %s: %s', collectionId, err, {
				channel: 'frontend.error',
				err: err,
				request: { id: requestId },
				job: { id: collectionId }
			} );
			throw new FrontendError( 'Could not fetch key from redis (internal error)', 500 );
		} );
}

function handleDownloadFile( requestId, args, response ) {
	var collectionId = args.collection_id;

	if ( !collectionId ) {
		throw new FrontendError( 'Collection ID must be given to obtain download.', 400 );
	}

	return redisClient.hget( config.redis.status_set_name, collectionId )
		.catch( function ( err ) {
			console.error( 'Redis error whilst fetching id %s: %s', collectionId, err, {
				channel: 'frontend.error',
				request: { id: requestId },
				job: { id: collectionId }
			} );
			throw new FrontendError( 'Could not fetch key from redis (internal error)', 500 );
		} )
		.then( function ( result ) {
			var obj;

			if ( !result ) {
				console.debug( 'Could not find key with id %s in redis', collectionId, {
					channel: 'frontend',
					request: { id: requestId },
					job: { id: collectionId }
				} );
				throw new FrontendError( 'CollectionID not found', 404 );

			} else {
				obj = JSON.parse( result );
				if ( obj.rendered_file_loc ) {
					return Promise.promisify( fs.stat )( obj.rendered_file_loc )
						.then( function ( stat ) {
							console.debug( 'Starting stream of file %s', obj.rendered_file_loc, {
								channel: 'frontend',
								request: { id: requestId },
								job: { id: collectionId }
							} );
							response.writeHead( 200,
								{ 'Content-Type': obj.content_type }
							);
							fs.createReadStream( obj.rendered_file_loc ).pipe( response );
						} )
						.catch( function (err ) {
							console.error(
								'Could not stat file "%s" for job %s',
								obj.rendered_file_loc,
								collectionId, {
									channel: 'frontend.error',
									request: { id: requestId },
									job: { id: collectionId }
								}
							);
							throw new FrontendError( 'Backend file could not be found', 404 );
						} );
				} else {
					console.error( 'No declared final file location for job %s', collectionId, {
						channel: 'frontend.error',
						request: { id: requestId },
						job: { id: collectionId }
					} );
					throw new FrontendError( 'Could not find rendered file on local disk.', 500 );
				}
			}
		} );
}

/**
 * Create a SHA hash of all pertinent metadata that affects how a book
 * is rendered.
 *
 * @param metabookObj {*} Object created from JSON.parse of the metabook parameter
 * @param writer {string} Target backend
 * @returns string
 */
function createCollectionId( metabookObj, writer ) {
	var collectionId = crypto.createHash( 'sha1' );

	var updateLine = function ( obj, k ) {
		// `encodeURIComponent` encodes any spaces or newlines,
		// Therefore it's safe to use spaces and newlines here to separate
		// fields.  (We could use any field separator which encodeURIComponent
		// percent-escapes, but this way is pretty.)  The string which we
		// hash is thus protected against collisions between (say)
		// { title: 'subtitle' } and { title: '', subtitle: '' }
		collectionId.update( util.format(
			"%s %s\n",
			encodeURIComponent( k ),
			encodeURIComponent( String( obj[k] || '' ) )
		) );
	};

	var keys = Object.keys( metabookObj );
	keys.sort();
	keys.forEach( function( k ) {
		if ( k === 'items' || k === 'settings' ) { return; }
		updateLine( metabookObj, k );
	} );

	var updateChapter = function ( items ) {
		if ( !items ) { return; } // People sometimes create empty chapters
		items.forEach( function ( item ) {
			if ( item.type === 'chapter' ) {
				updateLine( item, "title" );
				updateChapter( item.items );
			} else {
				updateLine( item, item.url ? "url" : "title" );
				if ( item.revision ) {
					updateLine( item, "revision" );
				}
			}
		} );
	};
	updateChapter( metabookObj.items );

	// XXX in the future we might separately cache the bundle.zip and
	// the final rendered output.  In that case the collection id would
	// be specific to the bundle, and we'd generate another id for the
	// bundle->backend step.  But at the moment we only cache the final
	// result, so we need to add the backend ("writer") to the hash.
	collectionId.update( writer );

	return collectionId.digest( 'hex' );
}

/**
 * Obtain the size in bytes of all the contents of a folder
 * @param {string} fspath - File system path
 * @returns {int} Size in bytes of the folder
 */
getFolderSize = (function() {
	var limit = Promise.guard.n( 100 ); // limit parallelism
	var lstat = Promise.guard( limit, Promise.promisify( fs.lstat, false, fs ) );
	var readdir = Promise.guard( limit, Promise.promisify( fs.readdir, false, fs ) );
	var CACHE_NURSERY = 5 * 60 * 1000; /*  5 minutes */
	var CACHE_EXPIRY = 60 * 60 * 1000; /* 60 minutes */
	var CACHE_JITTER =  1 * 60 * 1000; /*  1 minute */
	var cache = new Map();

	var computeSize = Promise.method(function( fspath ) {

		if ( !fspath ) {
			return 0;
		}

		return lstat( fspath ).then( function( stat ) {
			if ( !stat.isDirectory() ) {
				return stat.size;
			}
			// use cached value?  only if it's not too young & not too old.
			// (assumes directories are created and then filled with contents)
			var now = Date.now(), mtime = stat.mtime.getTime();
			var entry = cache.get( fspath );
			if (entry !== undefined &&
				entry.mtime === mtime &&
				CACHE_NURSERY < (now - mtime) &&
				CACHE_EXPIRY >= (now - entry.age)) {
				return entry.size;
			}
			// promise to compute the new size
			var sizeP = readdir( fspath ).map(function( item ) {
				return getFolderSize( path.join( fspath, item ) );
			}).reduce(function(total, size) {
				return total + size;
			}, 0);
			// add a little jitter to spread out the load so we don't
			// expire everything at once
			var age = now - (Math.random() * CACHE_JITTER);
			cache.set(fspath, { age: age, mtime: mtime, size: sizeP });
			return sizeP;
		} ).catch( function( err ) {
			if (err.code === 'ENOENT') {
				// race condition, files are getting cleaned up under us
				return 0;
			}
			console.warn( "Could not find size of %s: %s", fspath, err, {
				channel: 'frontend',
				err: err
			});
			return 0;
		} );
	});

	// gc method
	computeSize.gc = function() {
		var now = Date.now();
		cache.forEach(function( entry, fspath ) {
			if ( CACHE_EXPIRY < (now - entry.age)) {
				cache.delete( fspath );
			}
		});
	};

	// clear cache
	computeSize.clearCache = function() {
		cache.clear();
	};

	return computeSize;
})();

/**
 * HTTP error analogue; throw and code will be returned to HTTP client
 *
 * @param {string} message - Message that will be logged
 * @param {int} [httpCode=500] - HTTP status code to return if this error is not otherwise handled
 * otherwise handled
 *
 * @constructor
 * @extends{OcgError}
 */
function FrontendError( message, httpCode ) {
	FrontendError.super_.call( this, message );
	this.code = httpCode || 500;
}
util.inherits( FrontendError, eh.OcgError );

exports.init = init;
exports.start = startServer;
exports.stop = stopServer;

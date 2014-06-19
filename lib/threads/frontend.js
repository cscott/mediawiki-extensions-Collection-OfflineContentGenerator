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
var crypto = require( 'crypto' );
var fs = require( 'fs' );
var http = require( 'http' );
var mime = require( 'mime' );
var url = require( 'url' );
var util = require( 'util' );

var jd = require( '../JobDetails.js' );
var Redis = require( '../RedisWrapper.js' );

var config = null;
var eh = require( '../errorhelper.js' );
var redisClient = null;
var started = false;
var server = null;
var sprintf = require( 'sprintf-js' ).sprintf;

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
		console.error( 'Unexpected HTTP server error (terminating thread):' + err, {
			channel: 'frontend.error.fatal',
			error: eh.jsonify( err )
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
		console.debug( "Frontend requested to stop, but it never started." );
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
				}
			} );

			request.pipe( busboy );

		} else if ( request.method === 'GET' ) {
			args = url.parse( request.url, true ).query;
			resolve( args );

		} else {
			statsd.increment( 'frontend.requests.malformed' );
			reject( new FrontendError(
				"Unrecognized HTTP verb. Only GET and POST are supported.", 405
			) );
		}
	} )
	.then( function( args ) {
		return handleRequest( request.id, args, response );
	} )
	.catch( function( err ) {
		statsd.increment( 'frontend.request_errors' );
		if ( err instanceof FrontendError ) {
			console.error( err.message, {
				request: { id: request.id },
				error: eh.jsonify( err )
			} );
			response.writeHead( err.code || 500, JSON.stringify( {
				channel: 'frontend.error',
				request: { id: request.id },
				error: { message: err.message }
			} ) );
			response.end();
		} else {
			console.error( "Unexpected error, killing thread: " + err, {
				channel: 'frontend.error.fatal',
				request: { id: request.id },
				error: eh.jsonify( err )
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
	var time = Date.now();

	console.debug( 'Request details for ' + requestId, {
		channel: 'frontend.request.details',
		request: {
			id: requestId,
			params: args
		}
	} );
	statsd.increment( 'frontend.requests.' + args.command );

	switch ( args.command ) {
		case 'health':
			// TODO: Slightly more involved health check :)
			response.writeHead( 200, "OK" );
			response.end();
			break;
		case 'render':
			return handleRender( requestId, args, response );
		case 'render_status':
			return handleRenderStatus( requestId, args, response );
		case 'download':
			return handleDownload( requestId, args, response );
		default:
			throw new FrontendError( 'Unrecognized command', 400 );
	}

	statsd.timing( 'frontend.requests.' + args.command + 'response_time', Date.now() - time );
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
			collectionId = createCollectionId( metabookObj );
		}
	}

	if ( !forceRender ) {
		// TODO: Check to see if we already have a copy of the rendered content somewhere
		// and / or if the job is already in redis!
		/* jshint noempty: false */
	}

	if ( !isCached || forceRender ) {
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
		multi.exec( function ( err ) {
			if ( err ) {
				console.error(
					'Job insertion into redis failed for job %s with error: %s',
					collectionId,
					err,
					{
						channel: 'frontend.error',
						error: eh.jsonify( err ),
						request: { id: requestId },
						job: { id: collectionId }
					}
				);
				throw new FrontendError( 'Job insertion failed (redis failure?)', 500 );
			}
		} );
	}

	// Finally, respond to the client
	response.write( JSON.stringify( {
		collection_id: collectionId,
		writer:        writer,
		is_cached:     isCached
	} ) );
	response.end();
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
			console.err( 'Redis error whilst fetching id %s: %s', collectionId, err, {
				channel: 'frontend.error',
				error: eh.jsonify( err ),
				request: { id: requestId },
				job: { id: collectionId }
			} );
			throw new FrontendError( 'Could not fetch key from redis (internal error)', 500 );
		} );
}

function handleDownload( requestId, args, response ) {
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
							console.debug( 'Starting stream of file ' + obj.rendered_file_loc, {
								channel: 'frontend',
								request: { id: requestId },
								job: { id: collectionId }
							} );
							response.writeHead( 200,
								{ 'Content-Type': mime.lookup( obj.rendered_file_loc ) }
							);
							fs.createReadStream( obj.rendered_file_loc ).pipe( response );
						} )
						.catch( function (err ) {
							console.error(
								sprintf( 'Could not stat file "%s" for job %s',
									obj.rendered_file_loc,
									collectionId
								), {
									channel: 'frontend.error',
									request: { id: requestId },
									job: { id: collectionId }
								}
							);
							throw new FrontendError( 'Backend file could not be found', 404 );
						} );
				} else {
					console.error( 'No declared final file location for job ' + collectionId, {
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
 * @returns string
 */
function createCollectionId( metabookObj ) {
	var collectionId = crypto.createHash( 'sha1' );
	collectionId.update( metabookObj.title || '' );
	collectionId.update( metabookObj.subtitle || '' );

	var updateChapter = function ( items ) {
		items.forEach( function ( item ) {
			if ( item.type === 'chapter' ) {
				collectionId.update( item.title );
				updateChapter( item.items );
			} else {
				collectionId.update( item.url || item.title );
				collectionId.update( item.revision.toString() );
			}
		}
		);
	};
	updateChapter( metabookObj.items );

	return collectionId.digest( 'hex' );
}

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

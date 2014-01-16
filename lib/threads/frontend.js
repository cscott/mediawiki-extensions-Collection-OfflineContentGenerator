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

var Busboy = require('busboy');
var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var mime = require('mime');
var url = require('url');
var util = require('util');

var jd = require('../JobDetails.js');
var Redis = require('../RedisWrapper.js');

var config = null;
var started = false;
var server = null;
var redisClient = null;

/* === Public Exported Functions =========================================== */
/**
 * Initialize the frontend server with global objects
 *
 * @param config_obj Configuration object
 */
function init(config_obj) {
	config = config_obj;
	redisClient = new Redis(
		config.redis.host,
		config.redis.port,
		config.redis.password
	);
	server = http.createServer(decodeRequest);
}

/**
 * Starts the frontend server
 */
function startServer() {
	var socket = config.frontend.socket;
	var port = config.frontend.port;
	var address = config.frontend.address;

	var loop = false;
	redisClient.on('closed', function() {
		if (!loop) {
			loop = true;
			console.error('Redis died!?');
			stopServer(process.exit);
		}
	});
	redisClient.connect();

	function onListening() {
		console.debug('Frontend server reporting for duty on previously reported mechanism');
		started = true;
	}
	server.on('error', function(err) {
		console.error('Unexpected HTTP server error (terminating thread): %s, at %s', err, err.stack);
		stopServer(process.exit);
	});

	if (socket) {
		console.info('Frontend server starting on unix socket "%s"', socket);
		server.listen(socket, onListening);
	} else if (port) {
		console.info(
			'Frontend server starting on %s, port %s',
			address ? address : 'all IP interfaces',
			port
		);
		server.listen(port, address, onListening);
	} else {
		console.error('Frontend could not start, no server parameters specified');
		process.abort();
	}
}

/**
 * Stops (closes) the frontend server
 *
 * @param callbackFunc Function to call when server successfully closed
 */
function stopServer(callbackFunc) {
	redisClient.close();
	if (started) {
		server.close(callbackFunc);
	} else {
		console.debug("Interesting, apparently we never started. Just returning");
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
function decodeRequest(request, response) {
	var args = {};

	if (request.method === 'POST') {
		var busboy = new Busboy({
			headers: request.headers,
			fieldSize: 10 * 1024 *1024 // 10 MB
		});
		var continueRequest = true;

		busboy.on('field', function(field, value, valTruncated, keyTruncated) {
			if (valTruncated) {
				console.error('Field (%s) truncated when parsing POST, need to use bigger fieldSize', field);
				response.writeHead(413, "Field %s too long, max 10 MB", field);
				response.end();
				continueRequest = false;
			} else {
				args[field] = value;
			}
		});
		busboy.on('end', function() {
			if (continueRequest) {
				handleRequest(args, response);
			}
		});
		request.pipe(busboy);
	} else if (request.method === 'GET') {
		args = url.parse(request.url, true ).query;
		handleRequest(args, response);
	} else {
		response.writeHead(405, "Only GET and POST requests are supported");
		response.end();
	}
}

/**
 * Handle a HTTP request with decoded arguments.
 *
 * @param args Dictionary of combined GET/POST parameters
 * @param response http.ServerResponse
 */
function handleRequest(args, response) {
	console.debug('attempting to handle request: %s', JSON.stringify(args));
	try {
		switch (args.command) {
			case 'health':
				// TODO: Slightly more involved health check :)
				response.writeHead(200, "OK");
				response.end();
				break;
			case 'render':
				handleRender(args, response);
				break;
			case 'render_status':
				handleRenderStatus(args, response);
				break;
			case 'download':
				handleDownload(args, response);
				break;
			default:
				throw new FrontendError('Unrecognized command', 400);
		}
	} catch(err) {
		if (err instanceof FrontendError) {
			console.error("Error whilst serving request: %s", err.message);
			console.error(err.stack);
			response.writeHead(err.code || 500, err.message);
			response.end();
		} else {
			console.error('Unknown error, shutting down thread: ' + err);
			console.error(err.stack);

			response.writeHead(500, "Unexpected server error");
			response.end();

			server.close(function() {process.exit(1);});
		}
	}
}

/**
 * Handle injecting a render job (command=render)
 *
 * @param args URL parameters
 * @param response http.ServerResponse
 */
function handleRender(args, response) {
	var collectionId = args.collection_id;
	var metabook = args.metabook;
	var metabookObj = {};
	var writer = args.writer;
	var forceRender = args.force_render || false;
	var isCached = false;

	if (!writer || (typeof writer !== 'string')) {
		throw new FrontendError('Cannot begin "render" command: parameter "writer" not specified', 400);
	}

	if (!collectionId) {
		// Create the SHA hash of this collection request
		if (!metabook) {
			throw new FrontendError('Cannot begin "render" command: parameter "metabook" not specified', 400);
		} else {
			metabookObj = JSON.parse(metabook);
			if (!metabookObj) {
				throw new FrontendError('Cannot begin "render" command: parameter "metabook" not valid JSON', 400);
			}
			collectionId = createCollectionId(metabookObj);
		}
	}

	if (!forceRender) {
		// TODO: Check to see if we already have a copy of the rendered content somewhere
		// and / or if the job is already in redis!
		/* jshint noempty: false */
	}

	if (!isCached || forceRender) {
		// Shove a new job into redis
		console.info('Adding job with id %s to redis', collectionId);
		try {
			redisClient.multi()
				.rpush(
					config.redis.job_queue_name,
					collectionId
				)
				.hset(
					config.redis.status_set_name,
					collectionId,
					new jd.JobDetails(
						collectionId,
						metabookObj,
						writer
					).toJson()
				)
				.exec(function(err) { if (err) { throw err; } });
		} catch (err) {
			console.error('Job insertion into redis failed for job %s with error: %s', collectionId, err);
			throw new FrontendError('Job insertion failed (redis failure?)', 500);
		}
	}

	// Finally, respond to the client
	response.write(JSON.stringify({
		collection_id: collectionId,
		writer: writer,
		is_cached: isCached
	}));
	response.end();
}

function handleRenderStatus(args, response) {
	var collectionId = args.collection_id;

	if (!collectionId) {
		throw new FrontendError('Collection ID must be given to query render status.', 400);
	}

	console.debug('Attempting to obtain render status for collection id %s', collectionId);
	try {
		redisClient.hget(
			config.redis.status_set_name,
			collectionId,
			function(err, result) {
				var obj;
				if (err) {
					console.err('Redis error whilst fetching id %s: %s', collectionId, err);
					response.writeHead(500, 'Could not fetch key from redis (internal error)');
				} else if (!result) {
					console.debug('Could not find key with id %s in redis', collectionId);
					response.writeHead(404, 'CollectionID not found');
				} else {
					console.debug('Fetched object from redis by key %s', collectionId);
					obj = JSON.parse(result);
					response.write(JSON.stringify(obj));
				}
				response.end();
			}
		);
	} catch(err) {
		console.error('Job fetch from redis failed for job %s with error: %s', collectionId, err);
		throw new FrontendError('Job fetch failed (redis failure?)', 500);
	}
}

function handleDownload(args, response) {
	var collectionId = args.collection_id;

	if (!collectionId) {
		throw new FrontendError('Collection ID must be given to obtain download.', 400);
	}

	try {
		redisClient.hget(
			config.redis.status_set_name,
			collectionId,
			function(err, result) {
				var obj;
				if (err) {
					console.err('Redis error whilst fetching id %s: %s', collectionId, err);
					response.writeHead(500, 'Could not fetch key from redis (internal error)');
					response.end();
				} else if (!result) {
					console.debug('Could not find key with id %s in redis', collectionId);
					response.writeHead(404, 'CollectionID not found');
					response.end();
				} else {
					console.debug('Fetched object from redis by key %s: %s', collectionId, result);
					obj = JSON.parse(result);
					if (obj.rendered_file_loc) {
						fs.stat(obj.rendered_file_loc, function (err, stats) {
							if (err) {
								console.debug('Could not stat file "%s" for job %s', obj.rendered_file_loc, collectionId);
								response.writeHead(404, 'Backend file could not be found');
							} else {
								console.debug('Starting stream of file %s', obj.rendered_file_loc);
								response.writeHead(200, {'Content-Type': mime.lookup(obj.rendered_file_loc)});
								fs.createReadStream(obj.rendered_file_loc).pipe(response);
							}
						});
					} else {
						console.error('No declared final file location for job %s', collectionId);
						response.writeHead(500, 'Could not find rendered file on local disk.');
						response.end();
					}
				}
			}
		);
	} catch(err) {
		console.error('Job fetch from redis failed for job %s with error: %s', collectionId, err);
		throw new FrontendError('Job fetch failed (redis failure?)', 500);
	}
}

/**
 * Create a SHA hash of all pertinent metadata that affects how a book
 * is rendered.
 *
 * @param metabookObj {*} Object created from JSON.parse of the metabook parameter
 * @returns string
 */
function createCollectionId(metabookObj) {
	var collectionId = crypto.createHash('sha1');
	collectionId.update(metabookObj.title || '');
	collectionId.update(metabookObj.subtitle || '');

	var updateChapter = function(items) {
		items.forEach(function(item) {
			if (item.type === 'chapter') {
				collectionId.update(item.title);
				updateChapter(item.items);
			} else {
				collectionId.update(item.url || item.title);
				collectionId.update(item.revision.toString());
			}
		});
	};
	updateChapter(metabookObj.items);

	return collectionId.digest('hex');
}

/**
 * HTTP error analogue; throw and code will be returned to HTTP client
 *
 * @param message
 * @param code
 * @constructor
 */
function FrontendError( message, code ) {
	this.message = message;
	this.code = code || 500;
}
util.inherits(FrontendError, Error);

exports.init = init;
exports.start = startServer;
exports.stop = stopServer;

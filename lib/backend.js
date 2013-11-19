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

var Redis = require('./RedisWrapper.js');

var config = null;
var redisClient = null;

/* === Public Exported Functions =========================================== */
/**
 * Initialize the frontend server with global objects
 *
 * @param nconf Configuration object
 */
function initBackend(nconf) {
	config = nconf;

	redisClient = new Redis(
		nconf.get('redis:host'),
		nconf.get('redis:port'),
		nconf.get('redis:password')
	);
}

/**
 * Starts the backend server
 */
function startBackend() {
	var loop = false;
	redisClient.on('closed', function() {
		if (loop == false) {
			loop = true;
			console.error('Redis died!?');
			stopBackend(process.exit);
		}
	});
	redisClient.on('opened', getNewItemFromQueue);
	redisClient.connect();
	console.debug('Backend worker now listening for new jobs from queue');
}

/**
 * Stops (closes) the frontend server
 *
 * @param callbackFunc Function to call when server successfully closed
 */
function stopBackend(callbackFunc) {
	redisClient.close();
	callbackFunc();
}

/* === Private Functions =================================================== */
function getNewItemFromQueue() {
	redisClient.blpop(config.get('redis:job_queue_name'), 0, newItemFromQueue);
}
function newItemFromQueue(err, obj) {
	if (err) {
		console.error('Error picking up new job from queue (will kill myself): %s', err);
		stopBackend(process.exit);
	}
	jobDetails = JSON.parse(obj);
	console.info('Backend worker now picking up job: TODO');
	// Todo: do stuff :)
}

exports.init = initBackend;
exports.start = startBackend;
exports.stop = stopBackend;

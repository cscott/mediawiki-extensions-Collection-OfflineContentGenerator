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

var child_process = require('child_process');
var fs = require('fs');
var mime = require('mime');
var path = require('path');
var os = require('os');

var jd = require('../JobDetails.js');
var Redis = require('../RedisWrapper.js');

var config = null;
var redisClient = null;

/* === Public Exported Functions =========================================== */
/**
 * Initialize the frontend server with global objects
 *
 * @param config_obj Configuration object
 */
function initBackend(config_obj) {
	config = config_obj;
	if (!config.backend.temp_dir) {
		if (os.tmpdir) {
			config.backend.temp_dir = os.tmpdir();
		} else {
			// Node < 0.10
			config.backend.temp_dir = os.tmpDir();
		}
	}

	redisClient = new Redis(
		config.redis.host,
		config.redis.port,
		config.redis.password
	);
}

/**
 * Starts the backend server
 */
function startBackend() {
	var loop = false;
	redisClient.on('closed', function() {
		if (!loop) {
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
	redisClient.blpop(config.redis.job_queue_name, 0, function(err, obj) {
		if (err) {
			console.error('Error picking up new job from queue (will kill myself): %s', err);
			stopBackend(process.exit);
		} else {
			// Only the FSM knows why this function returns a list of [<listname>,<listitem>]
			if ((obj.length !== 2) || (!obj[1])) {
				console.error('Error picking up new job from queue (will kill myself): not a list');
				stopBackend(process.exit);
			} else {
				console.info('Got new job "%s", attempting to get status details and launching', obj[1]);
				redisClient.hget(config.redis.status_set_name, obj[1], newItemFromQueue);
			}
		}
	});
}
function newItemFromQueue(err, obj) {
	var tempMetabook, jobDetails;

	if (err) {
		console.error('Error picking up job status from queue (will kill myself): %s', err);
		stopBackend(process.exit);
	} else {
		jobDetails = JSON.parse(obj);
		console.info('Backend worker now picking up job %s for writer %s', jobDetails.collectionId, jobDetails.writer);

		// Save the JSON file to scratch space
		tempMetabook = path.join(config.backend.temp_dir, jobDetails.collectionId + '.json');
		fs.writeFile(
			tempMetabook,
			JSON.stringify(jobDetails.metabook),
			function(err) {
				if (err) {
					console.error('Could not create temporary file "%s": %s', tempMetabook, err);
					jd.updateError(jobDetails, 'Could not create temporary file');
					redisClient.hset(
						config.redis.status_set_name,
						jobDetails.collectionId,
						JSON.stringify(jobDetails)
					);
				} else {
					runBundler(jobDetails, tempMetabook);
				}
			}
		);
	}
}

function runBundler(jobDetails, metabookPath) {
	var child;
	var bundleFile = path.join(config.backend.temp_dir, jobDetails.collectionId + '.zip');

	// TODO: Don't do this if we have a cached bundle
	console.debug(
		'Forking child bundler to run job id %s (input: %s, output: %s)',
		jobDetails.collectionId,
		metabookPath,
		bundleFile
	);
	child = child_process.fork(config.backend.bundler.bin, [
		'-p', config.backend.bundler.parsoid_prefix,
		'-a', config.backend.bundler.parsoid_api,
		'-m', metabookPath,
		'-o', bundleFile
	]);
	child.on('error', function(err) {
		console.error('Bundler child reported back with spawn error: %s', err);
		jd.updateError(jobDetails, 'Could not launch bunlding process');
		redisClient.hset(config.redis.status_set_name, jobDetails.collectionId, JSON.stringify(jobDetails));
		getNewItemFromQueue();
	});
	child.on('message', function(message, handle) {
		try {
			jd.updateBundling(jobDetails, message.file, message.status, message.percent);
			redisClient.hset(config.redis.status_set_name, jobDetails.collectionId, JSON.stringify(jobDetails));
		} catch (err) {
			// Pass
		}
	});
	child.on('exit', function(code, signal) {
		console.info('Bundler child exited with: %s', code);
		if (code !== 0) {
			jd.updateError(jobDetails, 'Bundler process died unexpectedly');
			redisClient.hset(
				config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify(jobDetails)
			);
			getNewItemFromQueue();
		} else {
			// OK: Bundler completed, now launch the renderer and delete the metabook
			console.debug('Bundle completed successfully!');
			fs.unlink(metabookPath);
			runRenderer(jobDetails, bundleFile);
		}
	});

	// Update redis with the new status (e.g. that we're now rendering)
	// Progress to next state happens in the child.on('exit') above
	jd.updateBundling(jobDetails, null, 'Launching bundler', 0);
	redisClient.hset(config.redis.status_set_name, jobDetails.collectionId, JSON.stringify(jobDetails));
}

function runRenderer(jobDetails, bundleFile) {
	// TODO: It isn't safe to not check the writer (aka, do we have configuration for it)
	var child;
	var writer = jobDetails.writer;
	var renderFile = path.join(
		config.backend.temp_dir,
		jobDetails.collectionId + config.backend.writers[writer].extension
	);
	var url;

	console.debug(
		'Forking child renderer to run job id %s (input: %s, output: %s)',
		jobDetails.collectionId,
		bundleFile,
		renderFile
	);
	child = child_process.fork(config.backend.writers[writer].bin, [
		'-o', renderFile,
		bundleFile
	]);
	child.on('error', function(err) {
		console.error('Renderer child reported back with spawn error: %s', err);
		jd.updateError(jobDetails, 'Could not launch rendering process');
		redisClient.hset(config.redis.status_set_name, jobDetails.collectionId, JSON.stringify(jobDetails));
		getNewItemFromQueue();
	});
	child.on('message', function(message, handle) {
		try {
			jd.updateRendering(jobDetails, message.file, message.status, message.percent);
			redisClient.hset(config.redis.status_set_name, jobDetails.collectionId, JSON.stringify(jobDetails));
		} catch (err) {
			// Pass
		}
	});
	child.on('exit', function(code, signal) {
		console.info('Rendering child exited with: %s', code);
		if (code !== 0) {
			jd.updateError(jobDetails, 'Render process died unexpectedly');
			redisClient.hset(
				config.redis.status_set_name,
				jobDetails.collectionId,
				JSON.stringify(jobDetails)
			);
			getNewItemFromQueue();
		} else {
			// Yay; process finished! mark as such and get new job
			// We will instruct Collection to grab from a specific URL; because it's dumb...
			url = 'http://' + (config.coordinator.hostname || os.hostname()) +
				':' + (config.frontend.port || '80') +
				'/?command=download&collection_id=' + jobDetails.collectionId + '&writer=' + writer;

			fs.stat(renderFile, function (err, stats) {
				if (err) {
					console.debug('Could not stat file "%s". Render failed', renderFile);
					getNewItemFromQueue();
				} else {
					console.debug('Render completed successfully! Download URL: %s', url);

					// Delete the temporary metabook
					fs.unlink(bundleFile);

					// And because it's even more dumb we have to set the suggested file name, content size
					// and content type...
					jd.updateFinished(
						jobDetails,
						renderFile,
						url,
						mime.lookup(renderFile),
						jobDetails.metabook.title,
						stats.size
					);
					redisClient.hset(
						config.redis.status_set_name,
						jobDetails.collectionId,
						JSON.stringify(jobDetails),
						getNewItemFromQueue
					);
				}
			});
		}
	});
	jd.updateRendering(jobDetails, null, 'Launching renderer', 50);
	redisClient.hset(config.redis.status_set_name, jobDetails.collectionId, JSON.stringify(jobDetails));
}

exports.init = initBackend;
exports.start = startBackend;
exports.stop = stopBackend;

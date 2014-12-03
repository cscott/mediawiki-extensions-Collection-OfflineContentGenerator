#!/usr/bin/env node
"use strict";

/**
 * Collection Extension job queue empty script
 *
 * Use this script when the job queue needs to be urgently cleared. It
 * will go through each existing entry in the job queue and set the job
 * status to failed.
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

var commander = require( 'commander' );
var cli = require( '../lib/cli.js' );

var jd = require( '../lib/JobDetails.js' );
var Redis = require( '../lib/RedisWrapper.js' );
var redisClient = null;

commander
	.version( cli.version )
	.option( '-c, --config <path>', 'Path to the local configuration file' )
	.option( '-q, --quiet', "Don't add stdout to configured loggers")
	.parse( process.argv );

var config = cli.parseConfig( commander.config );
cli.setupLogging( config, !commander.quiet );

/* === Do the deed ========================================================
 * Basically, we check the number of entries in the list before, and then
 * do a simultaneous batched fetch/delete using MULTI(LRANGE, LTRIM). With
 * those metabookIds we then fetch the job status objects and set the status
 * to failed for any job which is still pending.
 * */

var BATCH_SIZE = 100;

var remaining = 0;
redisClient = new Redis(
	config.redis.host,
	config.redis.port,
	config.redis.password
);
redisClient.connect();
console.info('connected to redis');

function getMetabookIds() {
	var size = Math.min( BATCH_SIZE, remaining );
	console.info( 'Removing %s entries, %s remaining', size, remaining );

	var trimMulti = redisClient.multi();
	trimMulti.lrange( config.redis.job_queue_name, 0, size );
	trimMulti.ltrim( config.redis.job_queue_name, size, -1 );

	remaining -= size;
	Promise.promisify( trimMulti.exec, false, trimMulti )().then( getJobStatuses );
}

function getJobStatuses( metabookIds ) {
	var getMulti = redisClient.multi();

	metabookIds[0].forEach( function( metabookId ) {
		getMulti.hget( config.redis.status_set_name, metabookId );
	} );
	Promise.promisify( getMulti.exec, false, getMulti )().then( updateJobStatuses );
}

function updateJobStatuses( jsonJobDetails ) {
	var updateMulti = redisClient.multi();
	var job;
	jsonJobDetails.forEach( function( jjd ) {
		job = jd.fromJson( jjd );
		if ( job.state === 'pending' ) {
			job.updateError( 'Killed by administrative action' );
			updateMulti.hset( config.redis.status_set_name, job.collectionId, job.toJson() );
		}
	} );
	Promise.promisify( updateMulti.exec, false, updateMulti )().then( function() {
		console.info('return');
		if ( remaining > 0 ) {
			setTimeout( getMetabookIds, 1 );
		} else {
			console.info( 'done' );
			redisClient.close();
		}
	} );
}

redisClient.on('opened', function() {
	// Kick off the process by finding how many messages we have in the queue
	redisClient.llen( config.redis.job_queue_name ).then( function( len ) {
		remaining = len;
	} ).then( function() {
		// Now start the async loop
		getMetabookIds();
	} );
});

#!/usr/bin/env node
"use strict";

/**
 * Collection Extension queue cleaning script.
 *
 * This script will remove all cached job entries created in a certain
 * time period, specified on the command-line.  This is useful if
 * (for instance) a Parsoid bug corrupted generated HTML for some
 * time period (as occurred in
 * https://wikitech.wikimedia.org/wiki/Incident_documentation/20150424-Parsoid
 * for example).  Once the bug was fixed, you would run something like:
 *  $ sudo -u ocg -g ocg nodejs-ocg scripts/clear-time-range.js -c /etc/ocg/mw-ocg-service.js 2015-04-23T23:30-0700 2015-04-24T13:00-0700
 *
 * The script will not remove job status entries for pending jobs
 * (unless you use the `--force` flag).  It will complain on console
 * if it finds pending jobs, and exit with a non-zero exit code.
 * In that case, the operator should wait longer (say, 15 minutes)
 * for the pending job to complete and the user to collect the
 * results, before re-running the clear-time-range script.
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

var cli = require( '../lib/cli.js' );
var commander = require( 'commander' );
var os = require( 'os' );

// parse command-line options (with a possible additional config file override)
commander
	.version( cli.version )
	.usage('[options] <from date> <to date>')
	.option( '-c, --config <path>', 'Path to the local configuration file' )
	.option( '-f, --force', 'Remove even pending jobs' )
	.option( '-q, --quiet', "Don't add stdout to configured loggers")
	.parse( process.argv );

var config = cli.parseConfig( commander.config );
cli.setupLogging( config, !commander.quiet );
cli.setupStatsD( config );

if (commander.args.length !== 2) {
	console.error(
		'<from date> and <to date> are required arguments.',
		{ channel: 'gc' }
	);
	process.exit(1);
}
var fromDate = Date.parse(commander.args[0]);
var toDate = Date.parse(commander.args[1]);
var inTime = function(t) { return t >= fromDate && t <= toDate; };

/* === Do the deed ========================================================= */
var gc = require( '../lib/threads/gc.js' );
gc.init( config );
gc.singleRun(function() {
	var startTime = Date.now();
	var pending = 0;

	console.info(
		'Clearing cache between %s and %s',
		new Date(fromDate).toISOString(),
		new Date(toDate).toISOString(),
		{ channel: 'gc' }
	);

	return gc.cleanJobStatusObjects(function(job) {
		var deleteMe = (
			(job.timestamp && inTime(job.timestamp)) ||
			(job.job_start && inTime(job.job_start)) ||
			(job.job_end && inTime(job.job_end))
		);
		if (!deleteMe) {
			return false;
		}
		if (/^(finished|failed)$/.test(job.state)) {
			return true; /* delete this cache entry */
		}
		pending += 1;
		if (commander.force) {
			return true; /* force-remove this pending entry */
		}
		return false; /* don't remove it, it's still pending */
	}).spread(function(total, deleted) {
		console.info(
			'Cleared %d (of %d total) entries from cache in %s seconds',
			deleted, total, (Date.now() - startTime) / 1000,
			{ channel: 'gc' }
		);
		return pending;
	});
}).tap( function() {
	return new Promise(function(resolve) { gc.stop( resolve ); });
}).then( function(pending) {
	if (pending) {
		if (commander.force) {
			console.info(
				'Removed %d pending jobs.', pending,
				{ channel: 'gc' }
			);
		} else {
			console.error(
				'Refused to remove %d pending jobs.', pending,
				{ channel: 'gc' }
			);
			process.exit(1);
		}
	}
	process.exit(0);
}).done();

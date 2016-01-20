#!/usr/bin/env node
'use strict';

/**
 * Collection Extension host decommission script.
 *
 * This script will remove all cached job entries which refer to a
 * specific host, named on the command-line.  This is intended for use
 * when removing a host for maintenance.  First, you'd remove the host
 * from the round-robin DNS name specified in the Collection extension
 * configuration, so it no longer accepted new jobs.  Once the DNS change
 * propagated and any existing jobs on that host were complete, you
 * would run something like:
 *  $ sudo -u ocg -g ocg nodejs-ocg scripts/clear-host-cache.js -c /etc/ocg/mw-ocg-service.js ocg1002
 * where `ocg1002` is the name of the host you want to decommission.
 *
 * If the hostname is omitted, the script will use the name of the
 * host on which the script is running.
 *
 * The script will not remove job status entries for pending jobs
 * (unless you use the `--force` flag).  It will complain on console
 * if it finds pending jobs, and exit with a non-zero exit code.
 * In that case, the operator should wait longer (say, 15 minutes)
 * for the pending job to complete and the user to collect the
 * results, before re-running the clear-host-cache script.
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

require('core-js/shim');
var Promise = require('prfun');

var cli = require('../lib/cli.js');
var commander = require('commander');
var os = require('os');

// Parse command-line options (with a possible additional config file override).
commander
	.version(cli.version)
	.usage('[options] <hostname ...>')
	.option('-c, --config <path>', 'Path to the local configuration file')
	.option('-f, --force', 'Remove even pending jobs')
	.option('-q, --quiet', "Don't add stdout to configured loggers")
	.parse(process.argv);

var config = cli.parseConfig(commander.config);
cli.setupLogging(config, !commander.quiet);
cli.setupStatsD(config);

var hosts = commander.args.length ? commander.args :
	[ config.coordinator.hostname || os.hostname() ];

/* === Do the deed ========================================================= */
var gc = require('../lib/threads/gc.js');
gc.init(config);
gc.singleRun(function() {
	var startTime = Date.now();
	var pending = 0;

	console.info(
		'Clearing cache for hosts: %s', hosts.join(', '),
		{ channel: 'gc' }
	);
	var hostre = /^https?:\/\/([^:\/]*)/;

	return gc.cleanJobStatusObjects(function(job) {
		if (!job.host) {
			return false; /* Not picked up yet, keep. */
		}
		if (!hosts.some(function(h) { return h === job.host; })) {
			return false; /* Not on the specified host(s). */
		}
		if (/^(finished|failed)$/.test(job.state)) {
			return true; /* Delete this cache entry. */
		}
		pending += 1;
		if (commander.force) {
			return true; /* Force-remove this pending entry. */
		}
		return false; /* Don't remove it, it's still pending. */
	}).spread(function(total, deleted) {
		console.info(
			'Cleared %d (of %d total) entries from cache in %s seconds',
			deleted, total, (Date.now() - startTime) / 1000,
			{ channel: 'gc' }
		);
		return pending;
	});
}).tap(function() {
	return new Promise(function(resolve) { gc.stop(resolve); });
}).then(function(pending) {
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

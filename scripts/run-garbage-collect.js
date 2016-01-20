#!/usr/bin/env node
'use strict';

/**
 * Collection Extension garbage collection script
 *
 * This script will run a single run of the OCG garbage collector.
 * Normally you would not need to use this script as the OCG service
 * will run the thread at a pre-scheduled interval.
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

// Parse command-line options (with a possible additional config file override)
commander
	.version(cli.version)
	.option('-c, --config <path>', 'Path to the local configuration file')
	.option('-q, --quiet', "Don't add stdout to configured loggers")
	.parse(process.argv);

var config = cli.parseConfig(commander.config);
cli.setupLogging(config, !commander.quiet);
cli.setupStatsD(config);

/* === Do the deed ========================================================= */
var gc = require('../lib/threads/gc.js');
gc.init(config);
gc.singleRun().then(function() { gc.stop(process.exit); }).done();

#!/usr/bin/env node
"use strict";

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

require( 'es6-shim' );
require( 'prfun' );

var commander = require( 'commander' );
var logger = require( 'winston' );
var path = require( 'path' );

var StatsD = require( '../lib/statsd.js' );

/* === Configuration Options & File ======================================== */
var config = require( '../defaults.js' ), configPath;
commander
	.version( '0.0.1' )
	.option( '-c, --config <path>', 'Path to the local configuration file' )
	.parse( process.argv );

try {
	configPath = commander.config;
	if ( configPath ) {
		if ( path.resolve( configPath ) !== path.normalize( configPath ) ) {
			// If the configuration path given is relative, resolve it to be relative
			// to the current working directory instead of relative to the path of this
			// file.
			configPath = path.resolve( process.cwd, configPath );
		}
		config = require( configPath )( config );
	}
} catch ( err ) {
	console.error( "Could not open configuration file %s! %s", configPath, err );
	process.exit( 1 );
}

/* === Initial Logging ===================================================== */
// Remove the default logger
logger.remove( logger.transports.Console );
// Now go through the hash and add all the required transports
for ( var transport in config.logging ) {
	if ( config.logging.hasOwnProperty( transport ) ) {
		var parts = transport.split( '/' );
		var classObj = require( parts.shift() );
		parts.forEach( function( k ) {
			classObj = classObj[k];
		} );
		logger.add( classObj, config.logging[transport] );
	}
}
logger.extend( console );

global.statsd = new StatsD(
	config.reporting.statsd_server,
	config.reporting.statsd_port,
	config.reporting.prefix,
	'',
	config.reporting.is_txstatsd,
	false, // Don't globalize, we're doing that here
	true,  // Do cache DNS queries
	config.reporting.enable
);

/* === Do the deed ========================================================= */
var gc = require( '../lib/threads/gc.js' );
gc.init( config );
gc.singleRun().then( function() { gc.stop( process.exit ); } ).done();

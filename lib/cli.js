// common code for cli scripts.
"use strict";

var fs = require( 'fs' );
var path = require( 'path' );

var relativeTo = function(base, file) {
	if ( path.resolve( file ) !== path.normalize( file ) ) {
		// If the path given is relative, resolve it to be relative
		// to the given base.
		file = path.resolve( base, file );
	}
	return file;
};

// parse configuration files, with optional command-line override.
var parseConfig = exports.parseConfig = function(commander_config) {

	/* === Configuration Options & File === */
	var config = require( '../defaults.js' ), configPath = '..';
	// local configuration overrides
	while (config.config) {
		var config_file = relativeTo(configPath, config.config);
		delete config.config;
		try {
			fs.statSync(config_file);
		} catch (e) {
			break; // file not present
		}
		config = require( config_file )( config ) || config;
		configPath = path.dirname( config_file );
	}

	/* now allow command-line override */
	try {
		if ( commander_config ) {
			// If the configuration path given is relative, resolve it to be relative
			// to the current working directory instead of relative to the path of this
			// file.
			commander_config = relativeTo( process.cwd(), commander_config );
			config = require( commander_config )( config ) || config;
		}
	} catch ( err ) {
		console.error( "Could not open configuration file %s! %s", commander_config, err );
		process.exit( 1 );
	}
	return config;
};

// Set up logging.
var setupLogging = exports.setupLogging = function( config ) {
	var logger = require( 'winston' );
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
};

var setupStatsD = exports.setupStatsD = function( config ) {
	var StatsD = require( './statsd.js' );
	return (global.statsd = new StatsD(
		config.reporting.statsd_server,
		config.reporting.statsd_port,
		config.reporting.prefix,
		'',
		config.reporting.is_txstatsd,
		false, // Don't globalize, we're doing that here
		true,  // Do cache DNS queries
		config.reporting.enable
	));
};

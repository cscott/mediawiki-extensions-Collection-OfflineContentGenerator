// common code for cli scripts.
"use strict";

var fs = require( 'fs' ),
	path = require( 'path' ),
	assert = require( 'assert' );

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

	/* ensure some config checks */
	assert(
		config.frontend.failed_job_lockout_time <= config.garbage_collection.failed_job_lifetime,
		"Failed jobs shouldn't be gc'd before the lockout time expires."
	);

	return config;
};

// Set up logging.
var setupLogging = exports.setupLogging = function( config ) {
	var bunyan = require( 'bunyan' );
	var mkPrettyStream = function() {
		try {
			var PrettyStream = require('bunyan-prettystream');
			var ps = new PrettyStream();
			ps.pipe(process.stdout);
			return { type: 'raw', stream: ps };
		} catch (e) {
			/* optional bunyan-prettystream isn't present, use fallback */
			return { stream: process.stdout };
		}
	};
	var streams = (config.logging && Array.isArray(config.logging.streams)) ?
		config.logging.streams : [ mkPrettyStream() ];
	var serializers = (config.logging && config.logging.serializers) ||
		bunyan.stdSerializers;
	var logger = bunyan.createLogger({
		name: 'mw-ocg-service',
		streams: streams,
		serializers: serializers
	});
	// convenience: make these available on console.*
	['fatal','error','warn','info','debug','trace'].forEach(function(level) {
		console[level] = function() {
			// re-arrange 'meta' object of extra params, which bunyan expects
			// as the first argument. For winston and console.log compatibility
			// we put this as the last argument.
			var args = Array.prototype.slice.call(arguments);
			var meta = typeof args[args.length - 1] === 'object' ? args.pop() : {};
			args.unshift(meta);
			logger[level].apply(logger, args);
		};
	});
	// when debugging, console.log is nice to have as well.
	console.log = console.debug;
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

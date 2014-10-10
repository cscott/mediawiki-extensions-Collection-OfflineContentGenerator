"use strict";

require( 'es6-shim' );
require( 'prfun' );

var util = require( 'util' );
var events = require( 'events' );
var redis = require( 'redis' );

/**
 * @param host Host name to connect to
 * @param port Port to use to connect
 * @param password Password, if any, used to authenticate
 * @constructor
 */
var RedisWrapper = function( host, port, password ) {
	this.host = host;
	this.port = port;
	this.password = password;

	this.client = null;
	this.connected = false;
};

/**
 * Convenience wrapper around a redis connection.
 *
 * Emits:
 *   opened: On connection open
 *   closed: On connection closed (by close() or error)
 * @type {events.EventEmitter}
 */
util.inherits( RedisWrapper, events.EventEmitter );

/**
 * Connect to the redis server. Emits 'ready' when connected.
 *
 * @param retry_max_delay Max delay between connection attempts.
 */
RedisWrapper.prototype.connect = function( retry_max_delay ) {
	var self = this;

	console.debug(
		'Starting connection to redis on %s, port %s (using password: %s)',
		this.host,
		this.port,
		this.password ? true : false
	);
	this.client = redis.createClient(
		this.port,
		this.host,
		{
			enable_offline_queue: false,
			retry_max_delay: retry_max_delay || 60000,
			auth_pass: this.password
		}
	);

	function redisConnectionOpened() {
		console.debug( "Redis connection now ready" );
		self.connected = true;
		self.emit('opened');
	}

	function redisConnectionClosed( err ) {
		var wasConnected = self.connected;
		if ( err ) {
			console.error(
				'Redis connection (now %s) had error.',
				self.client.connected ? 'connected': 'disconnected',
				err
			);
		}

		self.connected = false;
		if ( wasConnected && !self.client.connected ) {
			self.emit( 'closed' );
		}
	}

	this.client.on( "error", redisConnectionClosed );
	this.client.on( "end", redisConnectionClosed );
	this.client.on( "ready", redisConnectionOpened );
};

/**
 * Gracefully closes the connection. Emits 'closed' when complete.
 */
RedisWrapper.prototype.close = function() {
	if ( this.client && this.client.connected ) {
		this.client.quit();
	} else {
		this.emit( 'closed' );
	}
};

/**
 * Constructs a primary key for a redis object
 *
 * @param collectionId CollectionID (SHA hash)
 * @param additional Any additional sub keys
 * @returns {string}
 */
RedisWrapper.prototype.key = function key( collectionId, additional ) {
	var i, str = 'ocg-collection';
	for ( i = 0; i < arguments.length; i++ ) {
		str += '-' + arguments[i];
	}
	return str;
};

// --- Redis Client Commands ---
RedisWrapper.prototype.watch = function( key ) {
	return Promise.promisify( this.client.watch, false, this.client )( key );
};
RedisWrapper.prototype.multi = function() {
	return this.client.multi();
};
RedisWrapper.prototype.blpop = function( key, timeout ) {
	return Promise.promisify( this.client.blpop, false, this.client )( key, timeout );
};
RedisWrapper.prototype.hset = function( hash, key, value ) {
	return Promise.promisify( this.client.hset, false, this.client )( hash, key, value );
};
RedisWrapper.prototype.hget = function( hash, key ) {
	return Promise.promisify( this.client.hget, false, this.client )( hash, key );
};
RedisWrapper.prototype.hdel = function( hash, key ) {
	return Promise.promisify( this.client.hdel, false, this.client )( hash, key );
};
RedisWrapper.prototype.llen = function( key ) {
	return Promise.promisify( this.client.llen, false, this.client )( key );
};
RedisWrapper.prototype.hlen = function( key ) {
	return Promise.promisify( this.client.hlen, false, this.client )( key );
};
RedisWrapper.prototype.hscan = function( key, cursor ) {
	if ( typeof(cursor)==='function' ) {
		// emulated hscan
		return cursor();
	}
	return Promise.promisify( this.client.hscan, false, this.client )( key, cursor ).catch( function( err ) {
		// (stable) redis 2.6 doesn't support hscan, boo.
		if (!/hscan/.test(err.message || '')) {
			throw err;
		}
		// emulate hscan -- the hkeys uses more memory, but still return
		// keys in chunks so that user is throttled.
		return Promise.promisify( this.client.hkeys, false, this.client )( key ).then( function( keys ) {
			var i = 0, COUNT = 50;
			// return keys 50 at a time.
			var some = function () {
				var next = keys.slice(i, i+COUNT);
				i += COUNT;
				return Promise.resolve([ i < keys.length ? some : 0, next ]);
			};
			return some();
		});
	}.bind( this ));
};

module.exports = RedisWrapper;

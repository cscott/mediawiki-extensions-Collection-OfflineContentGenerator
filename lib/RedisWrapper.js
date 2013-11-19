var events = require('events');
var redis = require('redis');

/**
 * @param host Host name to connect to
 * @param port Port to use to connect
 * @param password Password, if any, used to authenticate
 * @constructor
 */
var RedisWrapper = function(host, port, password) {
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
RedisWrapper.prototype = new events.EventEmitter;

/**
 * Connect to the redis server. Emits 'ready' when connected.
 *
 * @param retry_max_delay Max delay between connection attempts.
 */
RedisWrapper.prototype.connect = function(retry_max_delay) {
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
		console.debug("Redis connection now ready");
		self.connected = true;
		self.emit('opened');
	}

	function redisConnectionClosed( err ) {
		var wasConnected = self.connected;
		console.error(
			'Redis connection (now %s) had error: %s',
			self.client.connected ? 'connected': 'disconnected',
			err
		);
		self.connected = false;
		if (wasConnected && !self.client.connected) {
			self.emit('closed');
		}
	}

	this.client.on("error", redisConnectionClosed);
	this.client.on("end", redisConnectionClosed);
	this.client.on("ready", redisConnectionOpened);
};

/**
 * Gracefully closes the connection. Emits 'closed' when complete.
 */
RedisWrapper.prototype.close = function() {
	if (this.client && this.client.connected) {
		this.client.quit();
	} else {
		this.emit('closed');
	}
};

RedisWrapper.prototype.watch = function(key, callback) {
	return this.client.watch(key, callback);
};
RedisWrapper.prototype.multi = function() {
	return this.client.multi();
};
RedisWrapper.prototype.blpop = function(key, timeout, callback) {
	return this.client.blpop(key, timeout, callback);
};
RedisWrapper.prototype.hget = function(hash, key, callback) {
	return this.client.hget(hash, key, callback);
};

module.exports = RedisWrapper;
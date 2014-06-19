"use strict";

var util = require( 'util' );

/**
 * Base exception in the OCG system.
 *
 * To use this:
 * function NewErr( msg, code ) { NewErr.super_.call( this, msg ); this.code = code; }
 * util.inherits( NewErr, OcgError );
 *
 * @param message
 * @constructor
 */
var OcgError = function OcgError( message ) {
	Error.captureStackTrace( this, this.constructor );
	this.name = this.constructor.name;
	this.message = message;
};
util.inherits( OcgError, Error );
exports.OcgError = OcgError;

/**
 * Turn an error return into a OCG standard json log string
 * @param err
 */
exports.jsonify = function jsonify( err ) {
	if ( err instanceof OcgError ) {
		var el, obj = {};
		for ( el in err ) {
			obj[el] = err[el];
		}
		obj.stack = err.stack;
		return obj;
	} else if ( err instanceof Error ) {
		return {
			name: 'Unknown',
			message: err.message,
			stack: err.stack
		};
	} else {
		return {
			name: 'Unknown',
			message: err,
			stack: null
		};
	}
};

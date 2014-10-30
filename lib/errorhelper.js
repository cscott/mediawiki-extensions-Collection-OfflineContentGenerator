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

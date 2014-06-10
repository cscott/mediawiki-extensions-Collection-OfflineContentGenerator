"use strict";
var JobStatus = function() {
	/**
	 * Descriptive string on what's going on
	 * @type {string}
	 */
	this.status = 'Waiting for job runner to pick up render job';

	/**
	 * Article currently being rendered
	 * @type {string}
	 */
	this.article = null;

	/**
	 * Page number currently being rendered
	 * @type {number}
	 */
	this.page = null;

	/**
	 * Percentage complete
	 * @type {number}
	 */
	this.progress = 0.0;
};

var JobDetails = function(collectionId, metabook, writer) {
	/**
	 * Timestamp when this object was last updated
	 * @type {Date}
	 */
	this.timestamp = new Date();

	/**
	 * Unique collection ID
	 * @type {string}
	 */
	this.collectionId = collectionId;

	/**
	 * Writer to use when rendering
	 * @type {*}
	 */
	this.writer = writer;

	/**
	 * Status of the current job. May be progress or finished
	 * @type {string}
	 */
	this.state = 'pending';

	/**
	 * Metabook object with details of pages and sections (raw from collection extension)
	 * @type {*}
	 */
	this.metabook = metabook;

	/**
	 * Status of the current render job
	 * @type {JobStatus}
	 */
	this.status = new JobStatus();

	/**
	 * URL that will accept a GET for the final file
	 * @type {string}
	 */
	this.url = null;

	/**
	 * MIME type of the final file
	 * @type {string}
	 */
	this.content_type = null;

	/**
	 * Preconstructed content-disposition header for the final file
	 * @type {string}
	 */
	this.content_disposition = null;

	/**
	 * Size on disk, in bytes, of the final file
	 * @type {null}
	 */
	this.content_length = null;

	/**
	 * Location of the final file on disk
	 * @type {string}
	 */
	this.rendered_file_loc = null;
};

JobDetails.prototype._update = function _update(state, status, progress, article, page) {
	this.timestamp = new Date();
	this.state = state;

	this.status.status = status;
	this.status.progress = progress;
	this.status.page = page;
	this.status.article = article;
};

JobDetails.prototype.updateError = function updateError(error) {
	this.timestamp = new Date();
	this.state = 'failed';
	this.status.status = error;
};

JobDetails.prototype.updatePending = function updatePending(status, progress) {
	this._update('pending', status, parseFloat(progress), null, null);
};

JobDetails.prototype.updateBundling = function updateBundling(article, status, progress) {
	this._update('progress', status, 0.5 * parseFloat(progress), article, null);
};

JobDetails.prototype.updateRendering = function updateRendering(page, status, progress) {
	this._update('progress', status, 50 + (0.5 * parseFloat(progress)), null, page);
};

JobDetails.prototype.updateFinished = function updateFinished(fileloc, url, type, name, length) {
	this._update('finished', null, 100, null, null);

	// TODO: Ideally update the collection internal API to not expect this in the root object
	this.url = url;
	this.content_type = type;
	this.content_disposition = 'attachment; filename="' + name + '"';
	this.content_length = length;
	this.rendered_file_loc = fileloc;
};

JobDetails.prototype.toJson = function toJson() {
	return JSON.stringify(this);
};

exports.fromJson = function fromJson(jd) {
	var cls = new JobDetails(0, '', '' ),
		obj = JSON.parse(jd ),
		key;

	for(key in obj) {
		if (obj.hasOwnProperty(key)) {
			cls[key] = obj[key];
		}
	}

	return cls;
};

exports.JobDetails = JobDetails;

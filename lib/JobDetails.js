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
JobStatus.prototype.update = function(status, progress) {
	this.status = status;
	this.progress = progress;

	this.page = null;
	this.article = null;
};
JobStatus.prototype.updateByArticle = function updateByArticle(article, status, progress) {
	this.status = status;
	this.article = article;
	this.progress = progress;

	this.page = null;
};
JobStatus.prototype.updateByPage = function updateByPage(page, status, progress) {
	this.status = status;
	this.page = page;
	this.progress = progress;

	this.article = null;
};

var JobDetails = function(collectionId, metabook, writer, language) {
	/**
	 * Timestamp when this object was last updated
	 * @type {Date}
	 */
	this.timestamp = new Date();

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
	 * Unique collection ID
	 * @type {*}
	 */
	this.collectionId = collectionId;

	/**
	 * Metadata about the book
	 * @type {{}}
	 */
	this.metabook = metabook;

	/**
	 * Language this book is rendered in
	 * @type {string}
	 */
	this.language = language;

	/**
	 * Status of the current render job
	 * @type {JobStatus}
	 */
	this.status = new JobStatus();

	/**
	 * Filesystem location of the intermediate ZIP file
	 * @type {string}
	 */
	this.zipFileLoc = null;

	/**
	 * Filesystem location of the final output
	 * @type {null}
	 */
	this.renderedFileLoc = null;

	/**
	 * URL Download location for file
	 * @type {null}
	 */
	this.url = null;

	this.content_type = null;
	this.content_disposition = null;
	this.content_length = null;
};

exports.updatePending = function(jd, status, progress) {
	jd.timestamp = new Date();
	jd.state = 'pending';

	jd.status.status = status;
	jd.status.progress = progress;
	jd.status.page = null;
	jd.status.article = null;
};
exports.updateBundling = function(jd, article, status, progress) {
	jd.timestamp = new Date();
	jd.state = 'progress';

	jd.status.status = status;
	jd.status.article = article;
	jd.status.progress = progress;
	jd.status.page = null;
};
exports.updateRendering = function(jd, page, status, progress) {
	jd.timestamp = new Date();
	jd.state = 'progress';

	jd.status.status = status;
	jd.status.article = null;
	jd.status.progress = progress;
	jd.status.page = page;
};
exports.updateFinished = function(jd, file, url, type, name, length) {
	jd.timestamp = new Date();
	jd.state = 'finished';
	jd.renderedFileLoc = file;

	// Stupid collection stuff
	jd.url = url;
	jd.content_type = type;
	jd.content_disposition = 'attachment; filename="' + name + '"';
	jd.content_length = length;

	jd.status.status = '';
	jd.status.article = null;
	jd.status.progress = 100;
	jd.status.page = '';
};
exports.updateError = function(jd, error) {
	jd.timestamp = new Date();
	jd.state = 'failed';

	jd.status.status = error;
	jd.status.page = null;
	jd.status.article = null;
};

exports.JobStatus = JobStatus;
exports.JobDetails = JobDetails;
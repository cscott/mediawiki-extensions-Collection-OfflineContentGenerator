var JobStatus = function() {
	/**
	 * Status text to display
	 * @type {string}
	 */
	this.status = '';

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
JobStatus.prototype.updateByArticle = function updateByArticle(article, status, progress) {
	this.status = status;
	this.article = article;
	this.process = progress;

	this.page = null;
};
JobStatus.prototype.updateByPage = function updateByPage(page, status, progress) {
	this.status = status;
	this.page = page;
	this.process = progress;

	this.article = null;
};

var JobDetails = function(collectionId, metabook, writer, language) {
	/**
	 * Timestamp when this object was last updated
	 * @type {Date}
	 */
	this.timestamp = new Date();

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
};

exports.JobStatus = JobStatus;
exports.JobDetails = JobDetails;
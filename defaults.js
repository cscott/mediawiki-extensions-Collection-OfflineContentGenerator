/**
 * Default configuration file for the Collection extension Offline Content
 * Generator. Local settings should be in /etc/mw-collection-ocg.js with
 * settings modified in a function like:
 *
 * module.exports = function(config) { config.foo = 'bar'; }
 */
module.exports = {
	/** Location of local configuration override(s) (if present) */
	"config": "/etc/mw-collection-ocg.js",

	/** Service management thread, coordinates (re)launching threads and initial global setup */
	"coordinator": {
		/** The number of frontend threads to spawn. At the moment we don't have good data on how
		 * many clients can be served via a thread in a production environment.
		 */
		"frontend_threads": 2,
		/** The number of backend threads to spawn. These are heavy rendering threads and so should
		 * be set to some ratio of CPU cores. If set to "auto" the coordinator will launch a thread
		 * per CPU core.
		 */
		"backend_threads": "auto",

		/** Public hostname of this instance for HTTP GET requests for locally stored content. */
		"hostname": null
	},
	/** Configuration for the frontend HTTP server thread. You can choose to serve
	 * content via a local socket, or an IP address. If both are null the server will
	 * bind to all IP addresses.
	 */
	"frontend": {
		"address": null,
		"socket": null,
		"port": 17080
	},
	/** Configuration for the backend bundling & and rendering process threads. */
	"backend": {
		"bundler": {
			/** {int} Maximum time, in seconds, that the process will be allowed to execute.
			 * After the expiration time a SIGTERM will be issued. A value of zero means that
			 * no time limit is enforced.
			 */
			"max_execution_time": 0,
			"bin": "../mw-ocg-bundler/bin/mw-ocg-bundler",
			"additionalArgs": [],

			"parsoid_api": "http://localhost/",
			"parsoid_prefix": "localhost"
		},
		"writers": {
			"rdf2latex": {
				/** {int} Maximum time, in seconds, that the process will be allowed to execute.
				 * After the expiration time a SIGTERM will be issued. A value of zero means that
				 * no time limit is enforced.
				 */
				"max_execution_time": 0,

				"bin": "../mw-ocg-latexer/bin/mw-ocg-latexer",
				"additionalArgs": [],
				"extension": ".pdf"
			},
			"rdf2text": {
				/** {int} Maximum time, in seconds, that the process will be allowed to execute.
				 * After the expiration time a SIGTERM will be issued. A value of zero means that
				 * no time limit is enforced.
				 */
				"max_execution_time": 0,

				"bin": "../mw-ocg-texter/bin/mw-ocg-texter",
				"additionalArgs": [],
				"extension": ".txt"
			}
		},

		/** {string} Working directory for the service. If null will be in the OS temp dir. */
		"temp_dir": null,
		/** {string} Directory for final rendered output. If null will be temp_dir/ocg-output */
		"output_dir": null,
		/** {string|null} Directory where failed jobs will be stored. If null will not be stored. */
		"post_mortem_dir": null
	},
	/** Redis is used in both the frontend and backend for queueing jobs and job
	 * metadata storage.
	 */
	"redis": {
		"host": "localhost",
		"port": 6379,
		"password": null,
		"retry_max_delay": 60000,

		"job_queue_name": "ocg_render_job_queue",
		"status_set_name": "ocg_job_status",

		/** {int} When the job queue is larger than this, new jobs will be rejected. A zero value
		 * means no limit to the number of jobs that can be in the queue.
		 */
		"max_job_queue_length": 0
	},
	/** Active metric reporting via the StatsD protocol. General health can be obtained by querying
	 * the frontend with a HTTP GET ?request=health query
	 */
	"reporting": {
		/** If true will send UDP packets to the StatsD server. */
		"enable": false,
		/** Hostname to send StatsD metrics to. */
		"statsd_server": "localhost",
		/** Port to send StatsD metrics to. */
		"statsd_port": 8125,
		/** The txstatsd daemon can have non standard behaviour. If you're running the
		 * ConfigurableCollector set this to true.
		 */
		"is_txstatsd": false,
		/** Prefix for all statistics generated by this application */
		"prefix": "ocg.pdf."
	},
	/** Hash of winston compatible log transports to enable. The key is the name of the
	 * module to require followed by '/' and then the path in the module to the class.
	 * The value of the key is any option to pass to the logger.
	 */
	"logging": {
		"winston/transports/Console": { level: "info" }
	},
	/** Garbage collection thread */
	"garbage_collection": {
		/** Seconds between garbage collection runs */
		every: 0.25 * 24 * 60 * 60,
		/** Lifetime, in seconds, of a job status object in redis */
		job_lifetime: 3 * 24 * 60 * 60,
		/** Lifetime, in seconds, of any successful job artifacts on the file system */
		job_file_lifetime: 3.5 * 24 * 60 * 60,
		/** Lifetime, in seconds, of a job status object that failed in redis */
		failed_job_lifetime: 24 * 60 * 60,
		/** Lifetime, in seconds, of an object in the temp file system. Must be longer
		 * than the longest expected job runtime. (We check ctime not atime)
		 */
	  	temp_file_lifetime: 0.5 * 24 * 60 * 60,
		/** Lifetime, in seconds, of an object in the post mortem directory. */
	  	postmortem_file_lifetime: 5 * 24 * 60 * 60
	}
};

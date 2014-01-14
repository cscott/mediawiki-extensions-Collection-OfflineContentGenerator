/**
 * Default configuration file for the Collection extension Offline Content
 * Generator. Local settings should be in /etc/mw-collection-ocg.js with
 * settings modified in a function like:
 *
 * module.exports = function(config) { config.foo = 'bar'; }
 */
module.exports = {
	"coordinator": {
		"frontend_threads": 2,
		"backend_threads": "auto",
		"runtime_user": null,

		"hostname": null
	},
	"frontend": {
		"socket": null,
		"port": 17080,
		"address": "localhost"
	},
	"redis": {
		"host": "localhost",
		"port": 6379,
		"password": null,
		"retry_max_delay": 60000,

		"job_queue_name": "render_job_queue",
		"status_set_name": "job_status"
	},
	"backend": {
		"bundler": {
			"bin": "./bundler/bin/mw-ocg-bundler",
			"parsoid_api": "http://localhost/",
			"parsoid_prefix": "localhost"
		},
		"writers": {
			"rdf2latex": {
				"bin": "./latex_renderer/bin/mw-ocg-latexer",
				"extension": ".pdf"
			}
		},

		"temp_dir": null
	}
};

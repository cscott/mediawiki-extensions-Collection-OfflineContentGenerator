#!/usr/bin/env node
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var program = require('commander');
var bundler = require('mw-ocg-bundler');

var fs = require('fs');
var path = require('path');
var request = Promise.promisify(require('request'), true);

var cli = require('../lib/cli.js');

program
	.version(cli.version)
	.usage('[options] [pages.list]')
	.option('-a, --api <url>',
			// `ssh -L 17080:ocg.svc.eqiad.wmnet:8000 tin` might be handy!
			'OCG service API root', 'http://localhost:17080')
	.option('-f, --format <writer>',
			'Use the supplied backend [rdf2latex]', 'rdf2latex')
	.option('-p, --prefix <prefix>',
			'Restrict pages to those found in the given prefix', null)
	.option('-j, --jobs <N>',
			'How many jobs to queue at once [10]', 10)
	.option('--limit <N>',
			'Only queue the first N pages', null)
	.option('-o, --output <fileprefix>',
			'Save results to <fileprefix>-*.txt', null)
	.option('--parsoid <url>',
			// The default only works if you're testing pages on public wp
			'Parsoid API for article existence checks',
			'http://parsoid-lb.eqiad.wikimedia.org/')
	.option('-D, --debug',
			'Show failure details')
	.on('--help', function() {
		console.log('If page list is omitted, reads titles from pages.list');
	})
	.parse(process.argv);

var pagefile = (program.args.length === 0) ? path.join(__dirname, 'pages.list') :
	program.args[0];

// Read in `pages.list`
var titles = require('fs').readFileSync(pagefile, 'utf8').
	split(/(?:\n|\r\n?)+/g).reduce(function(prev, line) {
		var m = /^([^:]+):([\s\S]+)$/.exec(line);
		if (m) {
			prev.push({ prefix: m[1], title: m[2] });
		}
		return prev;
	}, []);

if (program.prefix) {
	titles = titles.filter(function(t) { return t.prefix === program.prefix; });
}
if (+program.limit) {
	titles.length = +program.limit;
}

// Create output files
var mkout = function(name) {
	if (program.output) {
		if (!/\/$/.test(program.output)) { name = '-' + name; }
		name = program.output + name;
	}
	return fs.createWriteStream(name, { encoding: 'utf8' });
};
var failedInject = mkout('failed-inject.txt');
var failedRender = mkout('failed-render.txt');
var passedRender = mkout('passed-render.txt');
var failedGroups = mkout('failed-groups.txt');

var crashGroups = {};
var notSure = '~ Not sure ~';

var doOne = Promise.guard(+program.jobs || 10, function(prefix, title) {
	var collectionId;
	console.log(prefix, title);
	return bundler.metabook.fromArticles(
		[ { prefix: prefix, title: title } ],
		{}
	).then(function(metabook) {
		metabook.title = title;
		// Submit it!
		return request({
			url: program.api,
			method: 'POST',
			encoding: 'utf8',
			pool: false,
			form: {
				command: 'render',
				writer: program.format,
				metabook: JSON.stringify(metabook),
				force_render: 'true',
			},
		}).spread(function(response, body) {
			if (response.statusCode !== 200) {
				throw new Error('Bad status: ' + response.statusCode);
			}
			return body;
		}).catch(function(error) {
			if (program.debug) {
				console.error('ERROR', error);
			}
			var e = new Error('failed inject');
			e.prefix = prefix; e.title = title;
			e.error = error;
			throw e;
		});
	}).then(function(body) {
		collectionId = JSON.parse(body).collection_id;
		// Check status until it's complete.
		var check = function() {
			return request({
				url: program.api,
				qs: {
					command: 'render_status',
					collection_id: collectionId,
				},
			}).spread(function(response, body) {
				if (response.statusCode !== 200) {
					throw new Error(
						'Bad status check: ' + response.statusCode
					);
				}
				body = JSON.parse(body);
				var state = body.state, status = body.status;
				if (/^(failed|finished)$/.test(state)) {
					if (state === 'failed') {
						var group = (status && status.status) || notSure,
							page = prefix + ' ' + title;
						if (Array.isArray(crashGroups[group])) {
							crashGroups[group].push(page);
						} else {
							crashGroups[group] = [ page ];
						}
					}
					return state;
				}
				if (!/^(pending|progress)$/.test(state)) {
					console.error('Job', collectionId, 'status', state);
				}
				return Promise.delay(1000).then(check);
			});
		};
		return check();
	}).then(function(status) {
		// Double check that failed articles actually exist: sometimes
		// the title list contains deleted articles.
		if (status === 'failed' && program.parsoid) {
			return request({
				url: program.parsoid.replace(/\/+$/, '') + '/' + prefix + '/' + title,
				pool: false,
			}).spread(function(response, body) {
				if (response.statusCode === 500 &&
					/Did not find page revisions for /.test(body)) {
					console.warn('*', prefix, title, 'has been deleted *');
					return 'finished';
				}
				return status;
			});
		}
		return status;
	}).then(function(status) {
		if (status === 'finished') {
			passedRender.write(prefix + ':' + title + '\n');
		} else {
			failedRender.write(prefix + ':' + title + '\n');
		}
		return status;
	}, function(error) {
		failedInject.write(prefix + ':' + title + '\n');
		if (error.message === 'failed inject') {
			if (program.debug) { console.log(error); }
			return 'failed_inject';
		}
		console.error('Unusual error', error);
		return 'error';
	});
});

Promise.map(titles, function(article) {
	return doOne(article.prefix, article.title);
}).then(function() {
	var groups = Object.keys(crashGroups);
	groups.sort(function(a, b) {
		if (a === notSure || b === notSure) {
			return (a === notSure) ? 1 : -1;
		}
		return crashGroups[b].length - crashGroups[a].length;
	});
	groups.forEach(function(group) {
		failedGroups.write(group + (new Array(group === notSure ? 5 : 3)).join('\n'));
		crashGroups[group].forEach(function(page) {
			failedGroups.write(page + '\n');
		});
		failedGroups.write('\n\n');
	});
}).finally(function() {
	return Promise.map([failedInject, failedRender, passedRender, failedGroups], function(s) {
		return new Promise(function(resolve, reject) {
			return s.end(function(error) {
				if (error) { return reject(error); }
				resolve();
			});
		});
	});
}).done();

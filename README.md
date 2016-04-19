# OfflineContentGenerator
[![dependency status][1]][2] [![dev dependency status][3]][4]

Render service (Offline Content Generator) for MediaWiki.

Ties together the MediaWiki [Collection] extension with
the [mw-ocg-bundler] and [mw-ocg-latexer]/[mw-ocg-texter]/etc backends.

## Running a development server
See [wiki](https://wikitech.wikimedia.org/wiki/OCG#Installing_a_development_instance)
for instructions on how to configure a local [Collection] extension to point
to this server.  But you can run a local instance with
```sh
apt-get install redis-server # runs a local redis service on port 6379
cd <repodir> ; npm install
./mw-ocg-service.js # starts a front end ocg service on port 17080
```

You also need to checkout and install [mw-ocg-bundler] and one or more
backends ([mw-ocg-latexer], [mw-ocg-texter], etc).  Although you can
specify any path to these in you like, the default configuration
expects them to be at the same directory level as `mw-ocg-bundler`,
eg:
```
$OCG/mw-ocg-service (this package)
$OCG/mw-ocg-bundler
$OCG/mw-ocg-latexer
$OCG/mw-ocg-texter
```

If you have installed [VisualEditor], no additional configuration will
be necessary: OCG will use the VisualEditor configuration to find an
appropriate RESTBase or Parsoid service and prefix.  No special
`localsettings.js` file will be required.

## Installing a standalone OCG without Visual Editor

In the absence of VisualEditor, you will still need to install
[Parsoid], and then configure OCG to use it.  Use the instructions in
the [Visual Editor configuration guide].

You will also have to launch `mw-ocg-service` as
`./mw-ocg-service.js -c localsettings.js` and
create a `localsettings.js` file containing:
```javascript
// for mw-ocg-service
module.exports = function(config) {
  // URL to the Parsoid instance
  // Use port 8142 if you use the Debian package
  config.backend.bundler.parsoid_api = "http://localhost:8000";
  // Use the Parsoid "v3" API
  // The "domainname" should match the "domain" in the setMwApi
  // call in Parsoid's localsettings.js and the "domain" in mediawiki's
  // $wgVirtualRestConfig in LocalSettings.php
  config.backend.bundler.additionalArgs = [ '--domainname=localhost', '--api-version=parsoid3' ];
}
```

As described in the [Visual Editor configuration guide] mentioned above,
Parsoid would in turn be configured with its own `localsettings.js`
containing:
```javascript
// for Parsoid
exports.setup = function( parsoidConfig ) {
  parsoidConfig.setMwApi({
    uri: 'http://path/to/your/mediawiki/api.php',
    domain: 'localhost',
    // (optional) "prefix" should match $wgDBname in your LocalSettings.php
    prefix: 'localhost'
  });
};
```

## Installing a production server on Ubuntu

Ensure that you have a redis server installed somewhere.

```sh
cd <repodir> ; npm install
ln -s <repodir>/mw-collection-ocg.conf /etc/init
initctl reload-configuration
service mw-collection-ocg start
```

Create `/etc/mw-collection-ocg.js` to configure the render service.
See [the default configuration](./defaults.js) for more details.

## Binary node modules
The following node binary module is required:
* sqlite3 (for `bundler` and `latex_renderer`)

In addition, better performance is obtained if the following binary
module is installed:
* hiredis (for this service)

Be aware of these when deploying to a new node version or machine
architecture.  You may need to `npm rebuild <package name>`.

## Logging
This software uses the bunyan logging framework. By default the framework
only logs to the system console. To add additional log transports and make it
useful, in the config file add lines like:

```
var bsyslog = require('bunyan-syslog');
config.logging = {
  streams: [{
    stream: process.stdout
  }, {
    level: 'debug',
    type: 'raw',
    stream: bsyslog.createBunyanStream({
      type: 'sys',
      facility: bsyslog.local0,
      name: 'mw-ocg-service'
    })
  }, {
    type: 'raw',
    stream: require('gelf-stream').forBunyan( '..host..', PORT)
  }],
  serializers: ... /* optional */
}
```

## Maintenance
The health check ```command=health``` will return the number of objects
currently in the job queue. If the job queue is too long, the operator can
either wait for the queue to clear, or log into the redis server with the
rediscli and run ```DEL``` with the keyname given by ```JobQueue.name``` in
the returned health hash, equivilant to the value of ```config.redis.job_queue_name```

## License

(c) 2014 by Brad Jorsch, C. Scott Ananian, Matthew Walker, Max Seminik

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, write to the Free Software Foundation, Inc.,
51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
http://www.gnu.org/copyleft/gpl.html

[Collection]:     https://www.mediawiki.org/wiki/Extension:Collection
[VisualEditor]:   https://www.mediawiki.org/wiki/Extension:VisualEditor
[Parsoid]:        https://www.mediawiki.org/wiki/Parsoid
[mw-ocg-bundler]: https://github.com/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-bundler
[mw-ocg-latexer]: https://github.com/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-latex_renderer
[mw-ocg-texter]:  https://github.com/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-text_renderer
[Visual Editor configuration guide]:  https://www.mediawiki.org/wiki/Extension:VisualEditor#Linking_with_Parsoid

[1]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator.png
[2]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator
[3]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator/dev-status.png
[4]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator#info=devDependencies

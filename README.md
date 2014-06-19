# OfflineContentGenerator
[![dependency status][1]][2] [![dev dependency status][3]][4]

Render service (Offline Content Generator) for MediaWiki.

Ties together the MediaWiki [Collection] extension with
the [mw-ocg-bundler] and [mw-ocg-latexer]/[mw-ocg-texter]/etc backends.

## Installation on Ubuntu

```
ln -s <repodir>/mw-collection-ocg.conf /etc/init
initctl reload-configuration
service mw-collection-ocg start
```

## Binary node modules
The following node binary modules are required:
* hiredis
* sqlite3 (for `bundler` and `latex_renderer`)

Be aware of these when deploying to a new node version or machine
architecture.  You may need to `npm rebuild <package name>`.

## Logging
This software uses the winston logging framework. By default the framework
only logs to the system console. To add additional log transports and make it
useful; in the config file add lines like:

```
logger.add( require( 'winston-posix-syslog' ).PosixSyslog, {} );
```

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
[mw-ocg-bundler]: https://github.com/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-bundler
[mw-ocg-latexer]: https://github.com/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-latex_renderer
[mw-ocg-texter]:  https://github.com/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator-text_renderer

[1]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator.png
[2]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator
[3]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator/dev-status.png
[4]: https://david-dm.org/wikimedia/mediawiki-extensions-Collection-OfflineContentGenerator#info=devDependencies

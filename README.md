# OfflineContentGenerator

## Installation on Ubuntu

```
ln -s <repodir>/mw-collection-ocg.conf /etc/init
initctl reload-configuration
service mw-collection-ocg start
```

## Binary node modules
The following node binary modules are required:
* hiredis
* rconsole
* sleep
* sqlite3 (for `bundler` and `latex_renderer`)

Be aware of these when deploying to a new node version or machine
architecture.  You may need to `npm rebuild <package name>`.

var crypto = require('crypto')
var fs = require('mz/fs')
var zlib = require('mz/zlib')
var path = require('path')
var mime = require('mime-types')
var compressible = require('compressible')
var readDir = require('fs-readdir-recursive')
var debug = require('debug')('koa-static-cache')

module.exports = function staticCache(dir, options, files) {
  if (typeof dir === 'object') {
    files = options
    options = dir
    dir = null
  }

  options = options || {}
  // prefix must be ASCII code
  options.prefix = (options.prefix || '').replace(/\/*$/, '/')
  files = new FileManager(files || options.files)
  dir = dir || options.dir || process.cwd()
  dir = path.normalize(dir)
  var enableGzip = !!options.gzip
  var filePrefix = path.normalize(options.prefix.replace(/^\//, ''))

  // option.filter
  var fileFilter = function () { return true }
  if (Array.isArray(options.filter)) fileFilter = function (file) { return ~options.filter.indexOf(file) }
  if (typeof options.filter === 'function') fileFilter = options.filter

  if (options.preload !== false) {
    readDir(dir).filter(fileFilter).forEach(function (name) {
      loadFile(name, dir, options, files)
    })
  }

  if (options.alias) {
    Object.keys(options.alias).forEach(function (key) {
      var value = options.alias[key]

      if (files.get(value)) {
        files.set(key, files.get(value))

        debug('aliasing ' + value + ' as ' + key)
      }
    })
  }

  return async (ctx, next) => {
    // only accept HEAD and GET
    if (ctx.method !== 'HEAD' && ctx.method !== 'GET') return await next()
    // check prefix first to avoid calculate
    if (ctx.path.indexOf(options.prefix) !== 0) return await next()

    // decode for `/%E4%B8%AD%E6%96%87`
    // normalize for `//index`
    var filename = path.normalize(safeDecodeURIComponent(ctx.path))
    var file = files.get(filename)

    // try to load file
    if (!file) {
      if (!options.dynamic) return await next()
      if (path.basename(filename)[0] === '.') return await next()
      if (filename.charAt(0) === path.sep) filename = filename.slice(1)

      // trim prefix
      if (options.prefix !== '/') {
        if (filename.indexOf(filePrefix) !== 0) return await next()
        filename = filename.slice(filePrefix.length)
      }

      var fullpath = path.join(dir, filename)
      // files that can be accessd should be under options.dir
      if (fullpath.indexOf(dir) !== 0) {
        return await next()
      }

      var s
      try {
        s = await fs.stat(fullpath)
      } catch (err) {
        return await next()
      }
      if (!s.isFile()) return await next()

      file = loadFile(filename, dir, options, files)
    }

    ctx.status = 200

    if (enableGzip) ctx.vary('Accept-Encoding')

    if (!file.buffer) {
      var stats = await fs.stat(file.path)
      if (stats.mtime > file.mtime) {
        file.mtime = stats.mtime
        file.length = stats.size
      }
    }

    ctx.response.lastModified = file.mtime

    if (ctx.fresh)
      return ctx.status = 304

    ctx.type = file.type
    ctx.length = file.zipBuffer ? file.zipBuffer.length : file.length
    ctx.set('Cache-Control', file.cacheControl || 'public, max-age=' + file.maxAge)

    if (ctx.method === 'HEAD')
      return

    var acceptGzip = ctx.acceptsEncodings('gzip') === 'gzip'
    var acceptBr = ctx.acceptsEncodings('br') === 'br'

    if (file.brBuffer && acceptBr) {
      ctx.set('Content-Encoding', 'br')
      ctx.body = file.brBuffer
      return;
    } else if (file.zipBuffer) {
      if (acceptGzip) {
        ctx.set('Content-Encoding', 'gzip')
        ctx.body = file.zipBuffer
      } else {
        ctx.body = file.buffer
      }
      return
    }

    var shouldGzip = enableGzip
      && file.length > 1024
      && acceptGzip
      && compressible(file.type)

    if (file.buffer) {
      if (shouldGzip) {

        file.brBuffer = file.brBuffer || await new Promise((resolve, reject) => {
          zlib.brotliCompress(file.buffer, (err, val) => err ? reject(err) : resolve(val), {
            [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
          });
        });
        if (acceptBr) {
          ctx.set('Content-Encoding', 'gzip')
          ctx.body = file.brBuffer;
          return;
        }
        var gzFile = files.get(filename + '.gz')
        if (options.usePrecompiledGzip && gzFile && gzFile.buffer) { // if .gz file already read from disk
          file.zipBuffer = gzFile.buffer
        } else {
          file.zipBuffer = await zlib.gzip(file.buffer, { level: 9 })
        }
        ctx.set('Content-Encoding', 'gzip')
        ctx.body = file.zipBuffer
      } else {
        ctx.body = file.buffer
      }
      return
    }

    var stream = fs.createReadStream(file.path)

    ctx.body = stream
    // enable gzip will remove content length
    if (shouldGzip) {
      ctx.remove('Content-Length')
      ctx.set('Content-Encoding', 'gzip')
      ctx.body = stream.pipe(zlib.createGzip({ level: 9 }))
    }
  }
}

function safeDecodeURIComponent(text) {
  try {
    return decodeURIComponent(text)
  } catch (e) {
    return text
  }
}

/**
 * load file and add file content to cache
 *
 * @param {String} name
 * @param {String} dir
 * @param {Object} options
 * @param {Object} files
 * @return {Object}
 * @api private
 */

function loadFile(name, dir, options, files) {
  var pathname = path.normalize(path.join(options.prefix, name))
  if (!files.get(pathname)) files.set(pathname, {})
  var obj = files.get(pathname)
  var filename = obj.path = path.join(dir, name)
  var stats = fs.statSync(filename)
  var buffer = fs.readFileSync(filename)

  obj.cacheControl = options.cacheControl
  obj.maxAge = obj.maxAge ? obj.maxAge : options.maxAge || 0
  obj.type = obj.mime = mime.lookup(pathname) || 'application/octet-stream'
  obj.mtime = stats.mtime
  obj.length = stats.size

  debug('file: ' + JSON.stringify(obj, null, 2))
  if (options.buffer)
    obj.buffer = buffer

  buffer = null
  return obj
}

function FileManager(store) {
  if (store && typeof store.set === 'function' && typeof store.get === 'function') {
    this.store = store
  } else {
    this.map = store || Object.create(null)
  }
}

FileManager.prototype.get = function (key) {
  return this.store ? this.store.get(key) : this.map[key]
}

FileManager.prototype.set = function (key, value) {
  if (this.store) return this.store.set(key, value)
  this.map[key] = value
}

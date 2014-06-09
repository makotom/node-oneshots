exports._write = function(data, encoding, cb) {
  // If we are still connecting, then buffer this for later.
  // The Writable logic will buffer up any more writes while
  // waiting for this one to be done.
  if (this._connecting) {
    this._pendingData = data;
    this._pendingEncoding = encoding;
    this.once('connect', function() {
      this._write(data, encoding, cb);
    });
    return;
  }
  this._pendingData = null;
  this._pendingEncoding = '';

  require("timers")._unrefActive(this);

  if (!this._handle) {
    this._destroy(new Error('This socket is closed.'), cb);
    return false;
  }

  var enc = Buffer.isBuffer(data) ? 'buffer' : encoding;
  var writeReq = createWriteReq(this._handle, data, enc);

  if (!writeReq || typeof writeReq !== 'object')
    return this._destroy(errnoException(process._errno, 'write'), cb);

  writeReq.oncomplete = afterWrite;
  this._bytesDispatched += writeReq.bytes;

  // If it was entirely flushed, we can write some more right now.
  // However, if more is left in the queue, then wait until that clears.
  if (this._handle.writeQueueSize === 0)
    cb();
  else
    writeReq.cb = cb;
};

function createWriteReq(handle, data, encoding) {
  switch (encoding) {
    case 'buffer':
      return handle.writeBuffer(data);

    case 'utf8':
    case 'utf-8':
      return handle.writeUtf8String(data);

    case 'ascii':
      return handle.writeAsciiString(data);

    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return handle.writeUcs2String(data);

    default:
      return handle.writeBuffer(new Buffer(data, encoding));
  }
}

function afterWrite(status, handle, req) {
  var self = handle.owner;
  var state = self._writableState;
  var debug = (function () {
    if (process.env.NODE_DEBUG && /net/.test(process.env.NODE_DEBUG)) {
      var pid = process.pid;
      return function(x) {
        // if console is not set up yet, then skip this.
        if (!console.error)
          return;
        console.error('NET: %d', pid,
                      util.format.apply(util, arguments).slice(0, 500));
      };
    } else {
      return function() { };
    }
  })();

  if (self !== process.stderr && self !== process.stdout)
    debug('afterWrite', status, req);

  // callback may come after call to destroy.
  if (self.destroyed) {
    debug('afterWrite destroyed');
    return;
  }

  if (status) {
    debug('write failure', errnoException(process._errno, 'write'));
    // self._destroy(errnoException(process._errno, 'write'), req.cb);
    return;
  }

  require("timers")._unrefActive(self);

  if (self !== process.stderr && self !== process.stdout)
    debug('afterWrite call cb');

  if (req.cb)
    req.cb.call(self);
}

function errnoException(errorno, syscall) {
  // TODO make this more compatible with ErrnoException from src/node.cc
  // Once all of Node is using this function the ErrnoException from
  // src/node.cc should be removed.
  var e = new Error(syscall + ' ' + errorno);
  e.errno = e.code = errorno;
  e.syscall = syscall;
  return e;
}
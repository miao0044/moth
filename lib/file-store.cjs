'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function failure(error) {
  return { ok: false, code: error.code || 'FILE_ERROR', message: error.message || String(error) };
}
function problem(code, message) {
  return Object.assign(new Error(message), { code });
}
function identity(stat) { return `${stat.dev}:${stat.ino}`; }
function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}
function version(stat, bytes) {
  return crypto.createHash('sha256')
    .update([stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs].join(':'))
    .update('\0').update(bytes).digest('hex');
}
function resolvedMissingPath(filePath) {
  try { return path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return filePath; }
}
function snapshot(filePath) {
  const absolute = path.resolve(filePath);
  let link;
  try { link = fs.lstatSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { exists: false, version: null, identity: null, realPath: resolvedMissingPath(absolute), absolute };
  }
  if (!link.isFile() && !link.isSymbolicLink()) {
    throw problem('UNSAFE_DESTINATION', 'The selected path is not a regular file.');
  }
  // Resolve the target so committing a save never replaces a symbolic link itself.
  const realPath = fs.realpathSync(absolute);
  const before = fs.statSync(realPath);
  if (!before.isFile()) throw problem('UNSAFE_DESTINATION', 'The selected path is not a regular file.');
  const descriptor = fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let stat;
  let bytes;
  try {
    stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw problem('UNSAFE_DESTINATION', 'The selected path is not a regular file.');
    bytes = fs.readFileSync(descriptor);
    if (!sameStat(stat, fs.fstatSync(descriptor)) || !sameStat(before, stat)) {
      throw problem('FILE_CHANGED', 'The file changed while it was being read. Try again.');
    }
  } finally { fs.closeSync(descriptor); }
  const currentLink = fs.lstatSync(absolute);
  if (!sameStat(link, currentLink) || fs.realpathSync(absolute) !== realPath ||
      !sameStat(stat, fs.statSync(realPath))) {
    throw problem('FILE_CHANGED', 'The file changed while it was being read. Try again.');
  }
  return {
    exists: true, absolute, realPath, stat, bytes,
    identity: identity(stat), version: version(stat, bytes),
    linkIdentity: link.isSymbolicLink() ? identity(link) : null,
  };
}
function publicSnapshot(value) {
  return { ok: true, exists: value.exists, version: value.version, identity: value.identity, realPath: value.realPath };
}
function inspectFile(filePath) {
  try { return publicSnapshot(snapshot(filePath)); }
  catch (error) { return failure(error); }
}
function readText(filePath) {
  try {
    const value = snapshot(filePath);
    if (!value.exists) throw problem('ENOENT', 'The file no longer exists.');
    return { ok: true, content: value.bytes.toString('utf8'), version: value.version, identity: value.identity, realPath: value.realPath };
  } catch (error) { return failure(error); }
}
function conflict(currentVersion) {
  return { ok: false, code: 'FILE_CHANGED', message: 'The file changed outside Moth. Review the changes before saving.', currentVersion };
}
function makeTemp(target, bytes, mode) {
  const temporary = path.join(path.dirname(target), `.moth-${crypto.randomBytes(12).toString('hex')}.tmp`);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    if (created) { try { fs.unlinkSync(temporary); } catch {} }
    throw error;
  }
}
function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Windows and some filesystems cannot open/fsync directories; the file itself is synced.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error.code)) throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function writeText(filePath, content, options = {}) {
  let temporary;
  try {
    if (typeof content !== 'string') throw problem('EINVAL', 'File contents must be text.');
    const initial = snapshot(filePath);
    const expected = Object.prototype.hasOwnProperty.call(options, 'expectedVersion');
    if (expected && options.expectedVersion !== initial.version) return conflict(initial.version);
    if (initial.exists && initial.stat.nlink > 1) {
      throw problem('HARDLINKED_FILE', 'This file has multiple hard links. Use Save As to save a separate copy.');
    }
    const parent = fs.realpathSync(path.dirname(initial.realPath));
    if (!fs.statSync(parent).isDirectory()) throw problem('ENOTDIR', 'The parent path is not a directory.');
    // Replacement should not bypass a read-only document merely because its folder is writable.
    if (initial.exists) fs.accessSync(initial.realPath, fs.constants.W_OK);
    temporary = makeTemp(initial.realPath, Buffer.from(content, 'utf8'), initial.exists ? initial.stat.mode & 0o7777 : 0o666 & ~process.umask());
    const current = snapshot(filePath);
    if ((expected && options.expectedVersion !== current.version) || initial.realPath !== current.realPath ||
        initial.exists !== current.exists || initial.linkIdentity !== current.linkIdentity ||
        fs.realpathSync(path.dirname(initial.realPath)) !== parent) {
      return conflict(current.version);
    }
    if (current.exists && current.stat.nlink > 1) {
      throw problem('HARDLINKED_FILE', 'This file has multiple hard links. Use Save As to save a separate copy.');
    }
    if (initial.exists) fs.renameSync(temporary, initial.realPath);
    else {
      // A link fails with EEXIST if another process creates the destination after our check.
      fs.linkSync(temporary, initial.realPath);
      fs.unlinkSync(temporary);
    }
    temporary = undefined;
    syncDirectory(parent);
    const saved = snapshot(filePath);
    if (!saved.exists || !saved.bytes.equals(Buffer.from(content, 'utf8'))) return conflict(saved.version);
    return { ok: true, version: saved.version, identity: saved.identity, realPath: saved.realPath };
  } catch (error) {
    if (error.code === 'EEXIST' && Object.prototype.hasOwnProperty.call(options, 'expectedVersion')) {
      const current = inspectFile(filePath);
      if (current.ok) return conflict(current.version);
    }
    return failure(error);
  }
  finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
}
function renameFile(oldPath, newPath, options = {}) {
  let linked = false;
  let destination;
  try {
    const source = path.resolve(oldPath);
    destination = path.resolve(newPath);
    const original = snapshot(source);
    if (Object.prototype.hasOwnProperty.call(options, 'expectedVersion') && options.expectedVersion !== original.version) {
      return conflict(original.version);
    }
    if (!original.exists) throw problem('ENOENT', 'The file no longer exists.');
    if (source === destination) return { ok: true, version: original.version, identity: original.identity, realPath: original.realPath };
    if (fs.realpathSync(path.dirname(source)) !== fs.realpathSync(path.dirname(destination))) {
      throw problem('EINVAL', 'Renaming is only supported within the same folder.');
    }
    // Hard-linking the directory entry preserves symlinks and cannot replace an existing name.
    fs.linkSync(source, destination);
    linked = true;
    const current = snapshot(source);
    // Creating our hard link updates ctime; compare the document itself while allowing that change.
    if (current.identity !== original.identity || !current.bytes.equals(original.bytes) ||
        current.stat.mtimeMs !== original.stat.mtimeMs || current.stat.mode !== original.stat.mode ||
        current.realPath !== original.realPath || current.linkIdentity !== original.linkIdentity) {
      throw problem('FILE_CHANGED', 'The file changed while it was being renamed.');
    }
    fs.unlinkSync(source);
    linked = false;
    syncDirectory(path.dirname(destination));
    const renamed = snapshot(destination);
    return { ok: true, version: renamed.version, identity: renamed.identity, realPath: renamed.realPath };
  } catch (error) {
    if (linked) { try { fs.unlinkSync(destination); } catch {} }
    return failure(error);
  }
}

module.exports = { readText, inspectFile, writeText, renameFile };

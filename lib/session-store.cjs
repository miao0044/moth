'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resultError(error) {
  return { ok: false, code: error.code || 'SESSION_ERROR', message: error.message || String(error) };
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.tabs)) {
    throw Object.assign(new Error('The saved session is not a supported Moth session.'), { code: 'INVALID_SESSION' });
  }
  return value;
}
function readSnapshot(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw Object.assign(new Error('The session path is not a regular file.'), { code: 'INVALID_SESSION' });
  try { return validate(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch (error) {
    if (error instanceof SyntaxError) error.code = 'INVALID_SESSION';
    throw error;
  }
}
function atomicPrivateWrite(filePath, contents) {
  const temporary = path.join(path.dirname(filePath), `.moth-session-${crypto.randomBytes(12).toString('hex')}.tmp`);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    if (created) { try { fs.unlinkSync(temporary); } catch {} }
  }
}
function preserveCorruptSnapshot(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile()) {
    throw Object.assign(new Error('The session path is not a regular file.'), { code: 'INVALID_SESSION' });
  }
  const bytes = fs.readFileSync(filePath);
  // Content-derived names avoid repeatedly archiving the same corrupt snapshot after a failed save.
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const preservedPath = `${filePath}.corrupt-${hash}`;
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(preservedPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST' && fs.lstatSync(preservedPath).isFile() && fs.readFileSync(preservedPath).equals(bytes)) return;
    if (created) { try { fs.unlinkSync(preservedPath); } catch {} }
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function syncDirectory(directory) {
  let descriptor;
  try { descriptor = fs.openSync(directory, 'r'); fs.fsyncSync(descriptor); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error.code)) throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function createSessionStore(userDataDir) {
  const currentPath = path.join(userDataDir, 'session.json');
  const backupPath = `${currentPath}.bak`;
  return {
    read() {
      let currentError;
      try { return { ok: true, session: readSnapshot(currentPath) }; }
      catch (error) { currentError = error; }
      try { return { ok: true, session: readSnapshot(backupPath), recoveredFromBackup: true }; }
      catch (backupError) {
        if (currentError.code === 'ENOENT' && backupError.code === 'ENOENT') return { ok: true, session: null };
        return resultError(currentError.code === 'ENOENT' ? backupError : currentError);
      }
    },
    write(session, options = {}) {
      try {
        const serialized = JSON.stringify(validate(session));
        // Validate the actual JSON too: toJSON hooks must not persist an invalid snapshot.
        validate(JSON.parse(serialized));
        fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
        let previous;
        try { previous = readSnapshot(currentPath); }
        catch (error) {
          // Keep the last valid backup when the primary snapshot is absent or corrupt.
          if (!['ENOENT', 'INVALID_SESSION'].includes(error.code)) throw error;
          if (error.code === 'INVALID_SESSION') preserveCorruptSnapshot(currentPath);
        }
        if (previous || options.discardPrevious === true) {
          try { readSnapshot(backupPath); }
          catch (error) {
            if (!['ENOENT', 'INVALID_SESSION'].includes(error.code)) throw error;
            if (error.code === 'INVALID_SESSION') preserveCorruptSnapshot(backupPath);
          }
          // An explicit discard must remove the draft from both recoverable snapshots.
          atomicPrivateWrite(backupPath, options.discardPrevious === true ? serialized : JSON.stringify(previous));
        }
        atomicPrivateWrite(currentPath, serialized);
        syncDirectory(userDataDir);
        return { ok: true };
      } catch (error) { return resultError(error); }
    },
  };
}

module.exports = { createSessionStore };

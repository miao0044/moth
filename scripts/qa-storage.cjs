'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readText, inspectFile, writeText, renameFile } = require('../lib/file-store.cjs');
const { createSessionStore } = require('../lib/session-store.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moth-storage-'));
let passed = 0;
function test(name, work) {
  work();
  passed += 1;
  console.log(`PASS ${name}`);
}
function patch(method, replacement, work) {
  const original = fs[method];
  fs[method] = (...args) => replacement(original, ...args);
  try { return work(); }
  finally { fs[method] = original; }
}
function file(name, contents = 'original') {
  const target = path.join(directory, name);
  fs.writeFileSync(target, contents);
  return target;
}
function cleanTemps(folder = directory) {
  assert.deepEqual(fs.readdirSync(folder).filter(name => name.startsWith('.moth-')), []);
}
function okay(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function code(result, expected) { assert.equal(result.ok, false); assert.equal(result.code, expected); }

try {
  test('text roundtrip, versions, UTF-8, and file mode', () => {
    const target = file('mode.md', 'before');
    fs.chmodSync(target, 0o640);
    const before = okay(readText(target));
    const saved = okay(writeText(target, '中文 and English\n', { expectedVersion: before.version }));
    const after = okay(readText(target));
    assert.equal(after.content, '中文 and English\n');
    assert.equal(saved.version, after.version);
    assert.notEqual(before.version, after.version);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    cleanTemps();
  });
  test('atomic save refuses to silently detach a hardlinked document', () => {
    const target = file('hardlinked-save.txt', 'shared original');
    const alias = path.join(directory, 'hardlinked-save-alias.txt');
    fs.linkSync(target, alias);
    const before = okay(readText(target));
    code(writeText(target, 'would detach alias', { expectedVersion: before.version }), 'HARDLINKED_FILE');
    assert.equal(fs.readFileSync(target, 'utf8'), 'shared original');
    assert.equal(fs.readFileSync(alias, 'utf8'), 'shared original');
    assert.equal(fs.statSync(target).ino, fs.statSync(alias).ino);
    cleanTemps();
  });
  test('missing reads and parents report ENOENT without creating folders', () => {
    const target = path.join(directory, 'absent', 'file.txt');
    code(readText(target), 'ENOENT');
    assert.equal(okay(inspectFile(target)).exists, false);
    code(writeText(target, 'text', { expectedVersion: null }), 'ENOENT');
    assert.equal(fs.existsSync(path.dirname(target)), false);
    code(writeText(directory, 'text'), 'UNSAFE_DESTINATION');
  });
  test('failed atomic replacement retains all original bytes and cleans temporary files', () => {
    const target = file('atomic.txt', 'do not lose this');
    const before = okay(readText(target));
    patch('renameSync', (original, source, dest) => {
      if (dest === target) throw Object.assign(new Error('Simulated replacement failure'), { code: 'EIO' });
      return original(source, dest);
    }, () => code(writeText(target, 'replacement', { expectedVersion: before.version }), 'EIO'));
    assert.equal(fs.readFileSync(target, 'utf8'), before.content);
    assert.equal(okay(readText(target)).version, before.version);
    cleanTemps();
  });
  test('failed temp writes retain all original bytes and clean temporary files', () => {
    const target = file('write-failure.txt', 'old bytes');
    patch('writeFileSync', (original, descriptor, bytes, options) => {
      if (typeof descriptor === 'number') throw Object.assign(new Error('Simulated disk full'), { code: 'ENOSPC' });
      return original(descriptor, bytes, options);
    }, () => code(writeText(target, 'new bytes'), 'ENOSPC'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'old bytes');
    cleanTemps();
  });
  test('read-only file and folder permissions are respected', () => {
    const target = file('readonly.txt');
    fs.chmodSync(target, 0o444);
    if (process.getuid?.() !== 0) code(writeText(target, 'not allowed'), 'EACCES');
    fs.chmodSync(target, 0o600);
    const folder = path.join(directory, 'readonly-folder');
    fs.mkdirSync(folder, { mode: 0o500 });
    try { if (process.getuid?.() !== 0) code(writeText(path.join(folder, 'new.txt'), 'not allowed'), 'EACCES'); }
    finally { fs.chmodSync(folder, 0o700); }
    cleanTemps();
  });
  test('symlink saves preserve the link and update the target', () => {
    const target = file('linked-target.txt', 'target');
    const link = path.join(directory, 'linked-document.txt');
    fs.symlinkSync(path.basename(target), link);
    const linkInode = fs.lstatSync(link).ino;
    const read = okay(readText(link));
    assert.equal(read.identity, okay(readText(target)).identity);
    okay(writeText(link, 'saved via link', { expectedVersion: read.version }));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(link).ino, linkInode);
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved via link');
    cleanTemps();
  });
  test('symlink retargeting during save prevents a commit', () => {
    const first = file('first-target.txt', 'first');
    const second = file('second-target.txt', 'second');
    const link = path.join(directory, 'retarget.txt');
    fs.symlinkSync(first, link);
    const read = okay(readText(link));
    let changed = false;
    patch('fsyncSync', (original, descriptor) => {
      const result = original(descriptor);
      if (!changed) { changed = true; fs.unlinkSync(link); fs.symlinkSync(second, link); }
      return result;
    }, () => code(writeText(link, 'my edit', { expectedVersion: read.version }), 'FILE_CHANGED'));
    assert.equal(fs.readFileSync(first, 'utf8'), 'first');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second');
    cleanTemps();
  });
  test('external changes conflict both before and immediately before commit', () => {
    const target = file('external.txt', 'before');
    const read = okay(readText(target));
    fs.writeFileSync(target, 'external change');
    code(writeText(target, 'my change', { expectedVersion: read.version }), 'FILE_CHANGED');
    assert.equal(fs.readFileSync(target, 'utf8'), 'external change');
    const latest = okay(readText(target));
    let changed = false;
    patch('fsyncSync', (original, descriptor) => {
      const result = original(descriptor);
      if (!changed) { changed = true; fs.writeFileSync(target, 'changed during save'); }
      return result;
    }, () => code(writeText(target, 'my edit', { expectedVersion: latest.version }), 'FILE_CHANGED'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'changed during save');
    cleanTemps();
  });
  test('new-file saves require a missing expected version and never clobber a create race', () => {
    const target = path.join(directory, 'brand-new.txt');
    okay(writeText(target, 'created', { expectedVersion: null }));
    code(writeText(target, 'overwrite', { expectedVersion: null }), 'FILE_CHANGED');
    const raced = path.join(directory, 'create-race.txt');
    patch('linkSync', (original, source, dest) => {
      if (dest === raced) fs.writeFileSync(raced, 'other app wins', { flag: 'wx' });
      return original(source, dest);
    }, () => code(writeText(raced, 'my edit', { expectedVersion: null }), 'FILE_CHANGED'));
    assert.equal(fs.readFileSync(raced, 'utf8'), 'other app wins');
    cleanTemps();
  });
  test('renames preserve content and reject existing paths, hardlink aliases, and create races', () => {
    const source = file('rename-source.txt', 'source');
    const target = file('rename-existing.txt', 'destination');
    code(renameFile(source, target), 'EEXIST');
    assert.equal(fs.readFileSync(target, 'utf8'), 'destination');
    const alias = path.join(directory, 'hardlink-alias.txt');
    fs.linkSync(source, alias);
    assert.equal(okay(inspectFile(source)).identity, okay(inspectFile(alias)).identity);
    code(renameFile(source, alias), 'EEXIST');
    const symlink = path.join(directory, 'rename-symlink.txt');
    fs.symlinkSync(source, symlink);
    code(renameFile(source, symlink), 'EEXIST');
    const raced = path.join(directory, 'rename-race.txt');
    patch('linkSync', (original, oldPath, newPath) => {
      if (newPath === raced) fs.writeFileSync(raced, 'other app wins', { flag: 'wx' });
      return original(oldPath, newPath);
    }, () => code(renameFile(source, raced), 'EEXIST'));
    assert.equal(fs.readFileSync(raced, 'utf8'), 'other app wins');
    assert.equal(fs.readFileSync(source, 'utf8'), 'source');
    const final = path.join(directory, 'rename-final.txt');
    okay(renameFile(source, final));
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(final, 'utf8'), 'source');
  });
  test('rename refuses an external version change without changing either path', () => {
    const source = file('stale-rename-source.txt', 'original draft');
    const destination = path.join(directory, 'stale-rename-destination.txt');
    const loaded = okay(readText(source));
    fs.writeFileSync(source, 'external edit');
    const current = okay(readText(source));
    const failed = renameFile(source, destination, { expectedVersion: loaded.version });
    code(failed, 'FILE_CHANGED');
    assert.equal(failed.currentVersion, current.version);
    assert.equal(fs.readFileSync(source, 'utf8'), 'external edit');
    assert.equal(fs.existsSync(destination), false);
    const existingDestination = file('stale-rename-existing.txt', 'keep destination');
    code(renameFile(source, existingDestination, { expectedVersion: loaded.version }), 'FILE_CHANGED');
    assert.equal(fs.readFileSync(existingDestination, 'utf8'), 'keep destination');
    okay(renameFile(source, destination, { expectedVersion: current.version }));
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'external edit');
    const missing = renameFile(source, path.join(directory, 'missing-rename-target.txt'), { expectedVersion: loaded.version });
    code(missing, 'FILE_CHANGED');
    assert.equal(missing.currentVersion, null);
  });
  test('normal rename returns the final version and keeps the same file identity', () => {
    const source = file('plain-rename.txt', 'rename me');
    const destination = path.join(directory, 'plain-renamed.txt');
    const before = okay(inspectFile(source));
    const renamed = okay(renameFile(source, destination));
    const after = okay(readText(destination));
    assert.equal(fs.existsSync(source), false);
    assert.equal(after.content, 'rename me');
    assert.equal(renamed.version, after.version);
    assert.equal(renamed.identity, before.identity);
  });
  test('symlink rename preserves its object and relative target', () => {
    const target = file('symlink-rename-target.txt', 'linked content');
    const source = path.join(directory, 'symlink-rename.txt');
    const destination = path.join(directory, 'symlink-renamed.txt');
    fs.symlinkSync(path.basename(target), source);
    const beforeInode = fs.lstatSync(source).ino;
    const renamed = okay(renameFile(source, destination));
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(destination).ino, beforeInode);
    assert.equal(fs.readlinkSync(destination), path.basename(target));
    assert.equal(fs.readFileSync(target, 'utf8'), 'linked content');
    assert.equal(renamed.identity, okay(inspectFile(target)).identity);
    assert.equal(renamed.version, okay(readText(destination)).version);
  });
  test('failed rename keeps source and removes its temporary destination', () => {
    const source = file('failed-rename-source.txt', 'source');
    const dest = path.join(directory, 'failed-rename-dest.txt');
    patch('unlinkSync', (original, target) => {
      if (target === source) throw Object.assign(new Error('Simulated unlink failure'), { code: 'EACCES' });
      return original(target);
    }, () => code(renameFile(source, dest), 'EACCES'));
    assert.equal(fs.readFileSync(source, 'utf8'), 'source');
    assert.equal(fs.existsSync(dest), false);
  });
  test('session roundtrip and private primary/backup modes', () => {
    const folder = path.join(directory, 'session-roundtrip');
    const store = createSessionStore(folder);
    assert.equal(okay(store.read()).session, null);
    const first = { version: 1, tabs: [{ id: 1, content: 'private draft' }] };
    const second = { version: 1, tabs: [{ id: 1, content: 'newer private draft' }], activeTabId: 1 };
    okay(store.write(first));
    assert.deepEqual(okay(store.read()).session, first);
    okay(store.write(second));
    assert.deepEqual(okay(store.read()).session, second);
    for (const name of ['session.json', 'session.json.bak']) {
      assert.equal(fs.statSync(path.join(folder, name)).mode & 0o777, 0o600);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'session.json.bak'), 'utf8')), first);
    cleanTemps(folder);
  });
  test('corrupt session falls back and never replaces last good backup with corrupt bytes', () => {
    const folder = path.join(directory, 'session-corrupt');
    const store = createSessionStore(folder);
    const first = { version: 1, tabs: [{ content: 'backup draft' }] };
    const second = { version: 1, tabs: [{ content: 'current draft' }] };
    okay(store.write(first));
    okay(store.write(second));
    fs.writeFileSync(path.join(folder, 'session.json'), '{broken');
    const recovered = okay(store.read());
    assert.equal(recovered.recoveredFromBackup, true);
    assert.deepEqual(recovered.session, first);
    okay(store.write(second));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'session.json.bak'), 'utf8')), first);
    fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify({ version: 99, tabs: [] }));
    assert.equal(okay(store.read()).recoveredFromBackup, true);
    code(store.write({ version: 2, tabs: [] }), 'INVALID_SESSION');
    cleanTemps(folder);
  });
  test('unrecoverable corrupt sessions retain private copies before replacement', () => {
    const folder = path.join(directory, 'session-both-corrupt');
    fs.mkdirSync(folder);
    const primary = path.join(folder, 'session.json');
    const backup = `${primary}.bak`;
    fs.writeFileSync(primary, '{broken primary');
    fs.writeFileSync(backup, '{broken backup');
    const store = createSessionStore(folder);
    code(store.read(), 'INVALID_SESSION');
    const session = { version: 1, tabs: [{ content: 'new draft' }] };
    okay(store.write(session));
    const primaryCopies = fs.readdirSync(folder).filter(name => name.startsWith('session.json.corrupt-'));
    assert.equal(primaryCopies.length, 1);
    assert.equal(fs.readFileSync(path.join(folder, primaryCopies[0]), 'utf8'), '{broken primary');
    assert.equal(fs.statSync(path.join(folder, primaryCopies[0])).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(backup, 'utf8'), '{broken backup');
    okay(store.write(session));
    const backupCopies = fs.readdirSync(folder).filter(name => name.startsWith('session.json.bak.corrupt-'));
    assert.equal(backupCopies.length, 1);
    assert.equal(fs.readFileSync(path.join(folder, backupCopies[0]), 'utf8'), '{broken backup');
    assert.equal(fs.statSync(path.join(folder, backupCopies[0])).mode & 0o777, 0o600);
    assert.deepEqual(okay(store.read()).session, session);
    cleanTemps(folder);
  });
  test('explicit discard sanitizes primary and backup so corruption cannot revive a draft', () => {
    const folder = path.join(directory, 'session-discard');
    const store = createSessionStore(folder);
    const dirty = { version: 1, tabs: [{ content: 'explicitly discarded draft', dirty: true }] };
    const sanitized = { version: 1, tabs: [] };
    okay(store.write(dirty));
    okay(store.write(sanitized, { discardPrevious: true }));
    for (const name of ['session.json', 'session.json.bak']) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')), sanitized);
      assert.equal(fs.statSync(path.join(folder, name)).mode & 0o777, 0o600);
    }
    fs.writeFileSync(path.join(folder, 'session.json'), '{corrupt after discard');
    const recovered = okay(store.read());
    assert.equal(recovered.recoveredFromBackup, true);
    assert.deepEqual(recovered.session, sanitized);
    cleanTemps(folder);
  });
  test('failed discard backup commit retains the entire prior session', () => {
    const folder = path.join(directory, 'session-discard-backup-failed');
    const store = createSessionStore(folder);
    const dirty = { version: 1, tabs: [{ content: 'not yet discarded', dirty: true }] };
    okay(store.write(dirty));
    okay(store.write(dirty));
    patch('renameSync', (original, source, dest) => {
      if (dest === path.join(folder, 'session.json.bak')) throw Object.assign(new Error('Backup commit failure'), { code: 'EIO' });
      return original(source, dest);
    }, () => code(store.write({ version: 1, tabs: [] }, { discardPrevious: true }), 'EIO'));
    assert.deepEqual(okay(store.read()).session, dirty);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'session.json.bak'), 'utf8')), dirty);
    cleanTemps(folder);
  });
  test('failed discard primary commit retains the current draft and reports failure', () => {
    const folder = path.join(directory, 'session-discard-primary-failed');
    const store = createSessionStore(folder);
    const dirty = { version: 1, tabs: [{ content: 'still open after failed discard', dirty: true }] };
    const sanitized = { version: 1, tabs: [] };
    okay(store.write(dirty));
    patch('renameSync', (original, source, dest) => {
      if (dest === path.join(folder, 'session.json')) throw Object.assign(new Error('Primary commit failure'), { code: 'EIO' });
      return original(source, dest);
    }, () => code(store.write(sanitized, { discardPrevious: true }), 'EIO'));
    assert.deepEqual(okay(store.read()).session, dirty);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'session.json.bak'), 'utf8')), sanitized);
    cleanTemps(folder);
  });
  test('session write failure retains a valid primary and backup without temp leaks', () => {
    const folder = path.join(directory, 'session-failed');
    const store = createSessionStore(folder);
    const first = { version: 1, tabs: [{ content: 'keep me' }] };
    okay(store.write(first));
    patch('renameSync', (original, source, dest) => {
      if (dest === path.join(folder, 'session.json')) throw Object.assign(new Error('Simulated session failure'), { code: 'EIO' });
      return original(source, dest);
    }, () => code(store.write({ version: 1, tabs: [{ content: 'new' }] }), 'EIO'));
    assert.deepEqual(okay(store.read()).session, first);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'session.json.bak'), 'utf8')), first);
    cleanTemps(folder);
  });
  console.log(`Storage QA passed (${passed} checks).`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

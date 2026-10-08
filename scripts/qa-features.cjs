'use strict';

// Real renderer + real storage, isolated profile/disk. Only native picker and
// confirmation decisions are fixtures; this never launches the installed app.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const JSZip = require('jszip');

const appRoot = process.env.MOTH_QA_APP_ROOT
  ? path.resolve(process.env.MOTH_QA_APP_ROOT) : path.join(__dirname, '..');
const diskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moth-features-qa-'));
const profileRoot = path.join(diskRoot, 'profile');
const fileStore = require(path.join(appRoot, 'lib/file-store.cjs'));
const sessionStore = require(path.join(appRoot, 'lib/session-store.cjs')).createSessionStore(profileRoot);
app.disableHardwareAcceleration();
app.setPath('userData', profileRoot);
app.on('window-all-closed', () => {});

const io = {
  argvFile: null, saveDialogCount: 0, savePaths: [], closeChoices: [], conflictChoices: [], reloadChoices: [],
  overwriteChoices: [], writes: [], prompts: [], sessionWrites: 0,
  beforeWrite: null, afterConflictChoice: null, pauseNextSession: false, pendingSession: null,
};
const report = {};
let window;
const rendererErrors = [];
const run = (code) => window.webContents.executeJavaScript(code, true);
const quote = JSON.stringify;
const file = (name, content) => {
  const result = path.join(diskRoot, name);
  fs.writeFileSync(result, content);
  return result;
};
function check(name, condition, details) {
  report[name] = Boolean(condition);
  assert.ok(condition, `${name}${details === undefined ? '' : ': ' + JSON.stringify(details)}`);
}
async function waitFor(code, test = Boolean, label = code) {
  let last;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    last = await run(code);
    if (test(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}: ${JSON.stringify(last)}`);
}
async function edit(text) {
  await run(`(() => {
    const tab = activeTab();
    tab.editorView.dispatch({ changes: { from: 0, to: tab.editorView.state.doc.length, insert: ${quote(text)} } });
  })()`);
  await waitFor(`activeTab().content === ${quote(text)} && activeTab().dirty`);
}
async function press(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await run('new Promise(resolve => requestAnimationFrame(resolve))');
}
function registerIpc() {
  ipcMain.handle('get-argv-file', () => io.argvFile);
  ipcMain.handle('window-is-maximized', () => false);
  ipcMain.handle('read-file', (_event, filePath) => fileStore.readText(filePath));
  ipcMain.handle('read-epub', (_event, filePath) => {
    try {
      const bytes = fs.readFileSync(filePath), stat = fs.statSync(filePath);
      return {ok:true,data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),size:bytes.length,mtimeMs:stat.mtimeMs};
    } catch (error) { return {ok:false,code:error.code,message:error.message}; }
  });
  ipcMain.handle('file-status', (_event, filePath) => fileStore.inspectFile(filePath));
  ipcMain.handle('write-file', (_event, filePath, content, options) => {
    if (io.beforeWrite) { const callback = io.beforeWrite; io.beforeWrite = null; callback(filePath); }
    const result = fileStore.writeText(filePath, content, options);
    io.writes.push({ filePath, content, options, result });
    return result;
  });
  ipcMain.handle('rename-file', (_event, from, to) => fileStore.renameFile(from, to));
  ipcMain.handle('read-dir', (_event, directory) => {
    try {
      return { ok: true, entries: fs.readdirSync(directory, { withFileTypes: true }).map(entry => ({
        name: entry.name, path: path.join(directory, entry.name), isDir: entry.isDirectory(), ext: path.extname(entry.name).toLowerCase()
      })) };
    } catch (error) { return { ok: false, code: error.code, message: error.message }; }
  });
  ipcMain.handle('open-folder', () => null);
  ipcMain.handle('open-file-dialog', () => null);
  ipcMain.handle('save-file-dialog', () => { io.saveDialogCount += 1; return io.savePaths.shift() || null; });
  ipcMain.handle('read-session', () => sessionStore.read());
  ipcMain.handle('write-session', (_event, snapshot, options) => {
    io.sessionWrites += 1;
    if (io.pauseNextSession) {
      io.pauseNextSession = false;
      return new Promise(resolve => { io.pendingSession = {snapshot, options, resolve}; });
    }
    return sessionStore.write(snapshot, options);
  });
  ipcMain.on('write-session-sync', (event, snapshot, options) => { io.sessionWrites += 1; event.returnValue = sessionStore.write(snapshot, options); });
  for (const [channel, queue, fallback] of [
    ['confirm-discard-changes', 'closeChoices', 'cancel'],
    ['confirm-file-conflict', 'conflictChoices', 'cancel'],
    ['confirm-reload', 'reloadChoices', false],
    ['confirm-overwrite', 'overwriteChoices', false],
  ]) {
    ipcMain.handle(channel, (_event, details) => {
      const choice = io[queue].length ? io[queue].shift() : fallback;
      io.prompts.push({ channel, details, choice });
      if (channel === 'confirm-file-conflict' && io.afterConflictChoice) {
        const callback = io.afterConflictChoice; io.afterConflictChoice = null; callback(choice);
      }
      return choice;
    });
  }
}
async function loadWindow() {
  window = new BrowserWindow({
    width: 900, height: 660, show: true, backgroundColor: '#262626',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  window.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 3 && !/Content-Security-Policy/.test(message)) rendererErrors.push(`${message} (${source}:${line})`);
  });
  await window.loadFile(path.join(appRoot, 'index.html'));
  await run('window.workspaceReady');
  await run('window.__qaAlerts = []; window.alert = message => window.__qaAlerts.push(message); void 0;');
  window.focus();
  window.webContents.focus();
}
async function restart() {
  check('sessionFlushSucceeds', await run('flushSession()'));
  // destroy skips renderer beforeunload, modelling an app crash after draft persistence.
  window.destroy();
  await loadWindow();
}
async function startupTests() {
  check('freshStartupHasOneFocusedEditor', await run('state.tabs.length === 1 && activeTab().kind === "text" && activeTab().path === null && activeTab().name === "Untitled.md" && !activeTab().dirty && activeTab().editorView.hasFocus'));
  const pristinePickerCount = io.saveDialogCount;
  check('untouchedStarterSaveAllNeedsNoPicker', await run('saveAllTabs()') && io.saveDialogCount === pristinePickerCount);
  const pristineCloseResponse = new Promise(resolve => ipcMain.once('window-close-response', (_event, answer) => resolve(answer)));
  window.webContents.send('window-close-requested');
  check('untouchedStarterWindowCloseNeedsNoPicker', await pristineCloseResponse === true && io.saveDialogCount === pristinePickerCount);
  window.destroy();
  await loadWindow();
  await window.webContents.insertText('Typing works immediately after launch');
  check('freshStartupAcceptsTypingWithoutClick', await waitFor('activeTab().content === "Typing works immediately after launch"'));
  io.closeChoices.push('discard');
  await run('closeTab(activeTab().id)');
  window.webContents.send('activate-text-workspace');
  await waitFor('state.tabs.length === 1 && activeTab()?.kind === "text" && activeTab().editorView.hasFocus');
  window.webContents.send('activate-text-workspace');
  await run('new Promise(resolve => requestAnimationFrame(resolve))');
  check('standaloneRelaunchEnsuresEditorWithoutDuplicates', await run('state.tabs.length === 1 && activeTab().kind === "text" && activeTab().editorView.hasFocus'));
  await run('closeTab(activeTab().id)');
  await run('flushSession()');
  window.destroy();
  const launchPath = file('launch-document.txt', 'explicit file launch');
  io.argvFile = launchPath;
  await loadWindow();
  check('fileLaunchDoesNotAddBlankTab', await run(`state.tabs.length === 1 && activeTab().path === ${quote(launchPath)} && activeTab().editorView.hasFocus`));
  io.argvFile = null;
  await restart();
  check('restoredTextLaunchDoesNotAddBlankTab', await run(`state.tabs.length === 1 && activeTab().path === ${quote(launchPath)} && activeTab().editorView.hasFocus`));

  const epubPath = path.join(diskRoot, 'startup-book.epub');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', {compression:'STORE'});
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">startup-test</dc:identifier><dc:title>Startup test</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-07T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  zip.file('OEBPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Startup test</h1><p>A tiny actual book for startup coverage.</p></body></html>');
  zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>');
  fs.writeFileSync(epubPath, await zip.generateAsync({type:'nodebuffer'}));
  await run('flushSession()');
  window.destroy();
  sessionStore.write({version:1,tabs:[{kind:'epub',path:epubPath,name:'startup-book.epub'}],activeIndex:0,recentFiles:[],closedTabs:[]}, {discardPrevious:true});
  await loadWindow();
  await waitFor('state.tabs.find(tab => tab.kind === "epub")?.epubView?.state === "ready"');
  check('epubOnlySessionAddsFocusedEditor', await run('state.tabs.length === 2 && state.tabs.filter(tab => tab.kind === "epub").length === 1 && activeTab().kind === "text" && activeTab().editorView.hasFocus'));
  await run('activateTab(state.tabs.find(tab => tab.kind === "epub").id)');
  window.webContents.send('activate-text-workspace');
  await waitFor('activeTab()?.kind === "text" && activeTab().editorView.hasFocus');
  check('standaloneRelaunchSelectsExistingTextTab', await run('state.tabs.length === 2 && state.tabs.filter(tab => tab.kind === "text").length === 1'));
  await run('flushSession()');
  window.destroy();
  sessionStore.write({version:1,tabs:[],recentFiles:[],closedTabs:[]}, {discardPrevious:true});
  io.argvFile = epubPath;
  await loadWindow();
  await waitFor('state.tabs.find(tab => tab.kind === "epub")?.epubView?.state === "ready"');
  check('epubFileLaunchDoesNotAddBlankTab', await run(`state.tabs.length === 1 && activeTab().kind === 'epub' && activeTab().path === ${quote(epubPath)}`));
  // Leave the comprehensive data-safety cases an empty workspace, as before.
  io.argvFile = null;
  await run('(async () => { for (const tab of [...state.tabs]) await closeTab(tab.id); state.recentFiles = []; state.closedTabs = []; await flushSession(); })()');
}
async function tests() {
  registerIpc();
  await loadWindow();
  await startupTests();

  const cleanPath = file('clean.txt', 'disk clean document');
  const dirtyPath = file('draft.md', '# saved baseline');
  await run(`openFile(${quote(cleanPath)})`);
  await run(`openFile(${quote(dirtyPath)})`);
  await edit('# dirty named draft 中文');
  await run('newFile()');
  await edit('untitled draft, not saved to a file');
  await waitFor('state.tabs.length === 3');
  await waitFor(`(() => {
    try {
      const session = JSON.parse(require('fs').readFileSync(${quote(path.join(profileRoot, 'session.json'))}, 'utf8'));
      return session.tabs.some(tab => tab.path === null && tab.content === 'untitled draft, not saved to a file');
    } catch { return false; }
  })()`);
  check('draftAutosaveRuns', true);
  await restart();
  const restored = await run('state.tabs.map(tab => ({path:tab.path,content:tab.content,savedContent:tab.savedContent,dirty:tab.dirty,active:tab.id===state.activeTab}))');
  check('draftRecoveryDoesNotAddExtraBlankTab', restored.length === 3 && restored.filter(tab => tab.path === null).length === 1);
  check('cleanSessionReopens', restored.some(tab => tab.path === cleanPath && !tab.dirty && tab.content === 'disk clean document'), restored);
  check('namedDraftRecovers', restored.some(tab => tab.path === dirtyPath && tab.dirty && tab.content === '# dirty named draft 中文' && tab.savedContent === '# saved baseline'), restored);
  check('untitledDraftRecoversActive', restored.some(tab => tab.path === null && tab.dirty && tab.active && tab.content === 'untitled draft, not saved to a file'), restored);
  check('recoveryDoesNotOverwriteDisk', fs.readFileSync(dirtyPath, 'utf8') === '# saved baseline');
  io.closeChoices.push('discard');
  check('explicitDiscardCloses', await run('closeTab(activeTab().id)'));
  check('discardSessionFlushSucceeds', await run('flushSession()'));
  // Recovery's backup is also part of explicit-discard semantics. Simulate
  // primary corruption without mutating the active renderer's documents.
  const sessionPath = path.join(profileRoot, 'session.json');
  const validSessionBytes = fs.readFileSync(sessionPath);
  let fallbackSession;
  try {
    fs.writeFileSync(sessionPath, '{invalid JSON');
    fallbackSession = sessionStore.read();
  } finally { fs.writeFileSync(sessionPath, validSessionBytes); }
  check('discardedDraftAbsentFromBackupRecovery', fallbackSession.ok
    && !fallbackSession.session.tabs.some(tab => tab.content === 'untitled draft, not saved to a file'));
  window.destroy();
  await loadWindow();
  check('discardDoesNotResurrect', await run('!state.tabs.some(tab => tab.content === "untitled draft, not saved to a file")'));

  await run(`activateTab(state.tabs.find(tab => tab.path === ${quote(dirtyPath)}).id)`);
  fs.writeFileSync(dirtyPath, '# external revision');
  await run('checkExternalChanges()');
  check('externalChangePreservesDraft', await run('activeTab().content === "# dirty named draft 中文" && activeTab().dirty'));
  check('externalChangeNoticeVisible', await run('!document.querySelector("#document-notice").hidden && document.querySelector("#document-notice").textContent.length > 0'));
  const priorWrites = io.writes.length;
  io.conflictChoices.push('cancel');
  check('conflictCancelRetainsDraft', await run('saveTab(activeTab())') === false && fs.readFileSync(dirtyPath, 'utf8') === '# external revision');
  check('conflictCancelNoSuccessfulWrite', io.writes.slice(priorWrites).every(write => !write.result.ok));
  io.conflictChoices.push('overwrite');
  check('confirmedOverwriteSaves', await run('saveTab(activeTab())') && fs.readFileSync(dirtyPath, 'utf8') === '# dirty named draft 中文');
  const guarded = io.writes.at(-1);
  check('confirmedOverwriteUsesVersionGuard', typeof guarded.options?.expectedVersion === 'string' && guarded.result.ok);

  await edit('retain this during reload decision');
  fs.writeFileSync(dirtyPath, 'reload this external disk content');
  io.reloadChoices.push(false);
  check('reloadCancelPreservesDraft', await run('reloadTab(activeTab())') === false && await run('activeTab().content === "retain this during reload decision"'));
  io.reloadChoices.push(true);
  check('reloadConfirmedReplacesDraft', await run('reloadTab(activeTab())') && await run('activeTab().content === "reload this external disk content" && !activeTab().dirty'));

  // Another write between the dialog and the commit must still be rejected.
  await edit('editor wins only with explicit confirmation');
  fs.writeFileSync(dirtyPath, 'external before confirmation');
  io.conflictChoices.push('overwrite', 'cancel');
  io.afterConflictChoice = () => { io.beforeWrite = target => fs.writeFileSync(target, 'external changed again during confirmation'); };
  check('overwriteRaceGuarded', await run('saveTab(activeTab())') === false
    && fs.readFileSync(dirtyPath, 'utf8') === 'external changed again during confirmation'
    && await run('activeTab().dirty'));

  // An alternate Save As target has no corresponding open draft to reload.
  // Main must omit that choice, and renderer defensively handles stale responses.
  const alternatePath = file('alternate-save-target.txt', 'alternate initial disk');
  const sourceBeforeAlternate = await run('({path:activeTab().path,content:activeTab().content,savedContent:activeTab().savedContent})');
  io.savePaths.push(alternatePath);
  io.overwriteChoices.push(true);
  io.conflictChoices.push('reload');
  io.beforeWrite = target => fs.writeFileSync(target, 'alternate changed before write');
  check('saveAsConflictRejectsSourceReload', await run('saveTab(activeTab(), {saveAs:true})') === false
    && await run(`activeTab().path === ${quote(sourceBeforeAlternate.path)} && activeTab().content === ${quote(sourceBeforeAlternate.content)} && activeTab().savedContent === ${quote(sourceBeforeAlternate.savedContent)} && activeTab().dirty`)
    && fs.readFileSync(alternatePath, 'utf8') === 'alternate changed before write');
  check('saveAsConflictOmitsReloadChoice', io.prompts.filter(prompt => prompt.channel === 'confirm-file-conflict').at(-1).details.allowReload === false);

  // Save As must identify aliases of a different tab, rather than compare names only.
  const aliasPath = path.join(diskRoot, 'clean-alias.txt');
  fs.symlinkSync(cleanPath, aliasPath);
  io.savePaths.push(aliasPath);
  io.overwriteChoices.push(true);
  const collisionWriteCount = io.writes.length;
  check('saveAsOpenAliasRejected', await run('saveTab(activeTab(), {saveAs:true})') === false);
  check('saveAsAliasDoesNotClobber', io.writes.length === collisionWriteCount && fs.readFileSync(cleanPath, 'utf8') === 'disk clean document');
  check('saveAsCollisionMessage', await run('!document.querySelector("#document-notice").hidden && /already open|open.*tab|another tab/i.test(document.querySelector("#document-notice").textContent)'));
  io.overwriteChoices.length = 0;

  // Existing rename destinations are protected and the failure is visible.
  const renameSource = file('rename-source.txt', 'source survives');
  const renameTarget = file('rename-target.txt', 'target survives');
  await run(`openFile(${quote(renameSource)})`);
  await run(`(async () => {
    window.__renameResult = 'pending';
    const input = await renameFile(${quote(renameSource)}, 'rename-source.txt', result => { window.__renameResult = result; input.remove(); });
    document.body.append(input); input.value = 'rename-target.txt';
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true,cancelable:true}));
  })()`);
  await waitFor('window.__renameResult !== "pending"');
  check('renameCannotClobber', fs.readFileSync(renameSource, 'utf8') === 'source survives' && fs.readFileSync(renameTarget, 'utf8') === 'target survives');
  check('renameFailureVisible', await run(`!document.querySelector('#document-notice').hidden && document.querySelector('#document-notice').textContent.includes('EEXIST')`));
  const renameOkSource = file('rename-ok.txt', 'ordinary rename content');
  const renameOkTarget = path.join(diskRoot, 'renamed-ok.txt');
  await run(`(async () => {
    window.__renameResult = 'pending';
    const input = await renameFile(${quote(renameOkSource)}, 'rename-ok.txt', result => { window.__renameResult = result; input.remove(); });
    document.body.append(input); input.value = 'renamed-ok.txt';
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true,cancelable:true}));
  })()`);
  await waitFor('window.__renameResult !== "pending"');
  check('ordinaryRenameSucceeds', !fs.existsSync(renameOkSource)
    && fs.existsSync(renameOkTarget) && fs.readFileSync(renameOkTarget, 'utf8') === 'ordinary rename content');

  // Discard the conflict draft before testing save-all over a clean workspace.
  io.closeChoices.push('discard');
  await run(`closeTab(state.tabs.find(tab => tab.path === ${quote(dirtyPath)}).id)`);
  await run(`activateTab(state.tabs.find(tab => tab.path === ${quote(renameSource)}).id)`);
  await edit('rename-source edited');
  await run(`activateTab(state.tabs.find(tab => tab.path === ${quote(cleanPath)}).id)`);
  await edit('clean file edited');
  await run('newFile()');
  await edit('new file saved by save-all');
  const saveAllPath = path.join(diskRoot, 'save-all-new.txt');
  io.savePaths.push(saveAllPath);
  check('saveAllCompletes', await run('saveAllTabs()'));
  check('saveAllWritesEveryDirtyDocument', fs.readFileSync(cleanPath, 'utf8') === 'clean file edited'
    && fs.readFileSync(renameSource, 'utf8') === 'rename-source edited'
    && fs.readFileSync(saveAllPath, 'utf8') === 'new file saved by save-all'
    && await run('dirtyTextTabs().length === 0'));

  await edit('save and close content');
  io.closeChoices.push('save');
  check('saveAndCloseCompletes', await run('closeTab(activeTab().id)') && fs.readFileSync(saveAllPath, 'utf8') === 'save and close content');
  await run('reopenClosedTab()');
  check('reopenClosedRestoresSavedFile', await run(`activeTab().path === ${quote(saveAllPath)} && activeTab().content === 'save and close content'`));
  await edit('cancel close content');
  io.closeChoices.push('cancel');
  check('closeCancelRetainsDirtyTab', await run('closeTab(activeTab().id)') === false && await run('activeTab().dirty'));
  await run('newFile()');
  await edit('failed close draft');
  io.closeChoices.push('save');
  io.savePaths.push(path.join(diskRoot, 'missing-directory', 'cannot-save.txt'));
  check('closeSaveFailureRetainsDraft', await run('closeTab(activeTab().id)') === false && await run('activeTab().path === null && activeTab().dirty && activeTab().content === "failed close draft"'));
  io.closeChoices.push('discard');
  await run('closeTab(activeTab().id)');
  check('reopenDiscardedDoesNotRecoverDiscardedText', await run(`(async () => { await reopenClosedTab(); return !state.tabs.some(tab => tab.content === 'failed close draft'); })()`));

  const missingPath = path.join(diskRoot, 'does-not-exist.txt');
  const tabCount = await run('state.tabs.length');
  await run(`openFile(${quote(missingPath)})`);
  check('readFailureVisibleNoBlankTab', await run(`!document.querySelector('#document-notice').hidden && document.querySelector('#document-notice').textContent.includes(${quote(missingPath)}) && state.tabs.length === ${tabCount}`));
  const recents = await run('state.recentFiles');
  check('recentFilesRecorded', recents.some(item => (typeof item === 'string' ? item : item.path) === saveAllPath), recents);
  await run(`closeTab(state.tabs.find(tab => tab.path === ${quote(cleanPath)}).id)`);
  await restart();
  check('recentFilesPersist', await run(`state.recentFiles.some(item => (typeof item === 'string' ? item : item.path) === ${quote(saveAllPath)})`));
  check('closedHistoryPersists', await run('state.closedTabs.length > 0'));

  // At the supported 600px minimum, only two small icon controls are added.
  window.setSize(600, 660);
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const controls = await run(`['#btn-save','#btn-file-menu'].map(selector => {
    const button=document.querySelector(selector), rect=button.getBoundingClientRect(), svg=button.querySelector('svg');
    return {label:button.getAttribute('aria-label'),text:button.textContent.trim(),width:rect.width,left:rect.left,right:rect.right,svg:Boolean(svg),stroke:svg?.getAttribute('stroke'),fill:svg?.getAttribute('fill'),strokeWidth:svg?.getAttribute('stroke-width')};
  })`);
  check('compactIconControlsMatchOriginalStyle', controls.every(button => button.label && !button.text && button.svg && button.width <= 36 && button.left >= 0 && button.right <= 600 && button.stroke === 'currentColor' && button.fill === 'none' && button.strokeWidth === '1.5'), controls);
  await run('document.querySelector("#btn-file-menu").focus()');
  await press('Enter');
  await waitFor('!document.querySelector("#file-menu").hidden');
  check('fileMenuKeyboardFocus', await run('document.activeElement.getAttribute("role") === "menuitem"'));
  const firstItem = await run('document.activeElement.textContent');
  await press('Down');
  check('fileMenuKeyboardNavigation', await run(`document.activeElement.getAttribute('role') === 'menuitem' && document.activeElement.textContent !== ${quote(firstItem)}`));
  const menuRect = await run('document.querySelector("#file-menu").getBoundingClientRect().toJSON()');
  check('fileMenuFitsNarrowWindow', menuRect.left >= 0 && menuRect.right <= 600 && menuRect.bottom <= 660, menuRect);
  await press('Escape');
  check('fileMenuEscapeRestoresFocus', await run('document.querySelector("#file-menu").hidden && document.activeElement.id === "btn-file-menu"'));
  await run('document.querySelector("#btn-file-menu").click()');
  check('saveCommandsDiscoverable', await run(`['Save As','Save All','Reopen Closed Tab'].every(label => Array.from(document.querySelectorAll('#file-menu [role="menuitem"]')).some(item => item.textContent.includes(label)))`));
  const screenshotPath = path.join(os.tmpdir(), 'moth-features-qa.png');
  fs.writeFileSync(screenshotPath, (await window.capturePage()).toPNG());
  const clearAction = await run(`(() => {
    const item = Array.from(document.querySelectorAll('#file-menu [role="menuitem"]')).find(item => /clear.*recent/i.test(item.textContent));
    if (!item) return false; item.click(); return true;
  })()`);
  check('clearRecentActionAvailable', clearAction);
  await waitFor('state.recentFiles.length === 0');
  await restart();
  check('recentClearPersists', await run('state.recentFiles.length === 0'));
  // Delay the final clean-window recovery write, then inject a real editor
  // mutation while it is pending. A stale close approval must not lose that text.
  io.closeChoices.push(...Array(await run('dirtyTextTabs().length')).fill('discard'));
  await run('(async () => { for (const tab of [...state.tabs]) await closeTab(tab.id); })()');
  const closeRacePath = file('final-close-race.txt', 'clean before closing');
  await run(`openFile(${quote(closeRacePath)})`);
  await run('flushSession()');
  const closeResponse = new Promise(resolve => ipcMain.once('window-close-response', (_event, answer) => resolve(answer)));
  io.pauseNextSession = true;
  window.webContents.send('window-close-requested');
  const waitStarted = Date.now();
  while (!io.pendingSession && Date.now() - waitStarted < 8000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(io.pendingSession, 'close reaches the delayed recovery write');
  await edit('late edit during final recovery write');
  const pending = io.pendingSession;
  io.pendingSession = null;
  pending.resolve(sessionStore.write(pending.snapshot, pending.options));
  const closeAllowed = await closeResponse;
  check('lateEditCancelsStaleCloseApproval', closeAllowed === false);
  check('lateCloseEditPersisted', sessionStore.read().session.tabs.some(tab => tab.path === closeRacePath && tab.content === 'late edit during final recovery write' && tab.dirty));
  check('lateCloseEditRemainsOpen', await run('activeTab().content === "late edit during final recovery write" && activeTab().dirty'));
  check('noUnexpectedRendererErrors', rendererErrors.length === 0, rendererErrors);
  console.log(JSON.stringify({checks:report, writes:io.writes.length, sessionWrites:io.sessionWrites, screenshotPath}, null, 2));
}

const watchdog = setTimeout(() => { console.error('Feature QA exceeded 120 seconds'); app.exit(1); }, 120000);
app.whenReady().then(tests).then(() => {
  clearTimeout(watchdog);
  window?.destroy();
  fs.rmSync(diskRoot, {recursive:true, force:true});
  app.exit(0);
}, async error => {
  clearTimeout(watchdog);
  console.error(error.stack || error);
  console.error(JSON.stringify({checks:report, prompts:io.prompts, writes:io.writes, rendererErrors, diskRoot}, null, 2));
  try { fs.writeFileSync(path.join(os.tmpdir(), 'moth-features-qa-failure.png'), (await window.capturePage()).toPNG()); } catch {}
  window?.destroy();
  app.exit(1);
});

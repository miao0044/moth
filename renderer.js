const { ipcRenderer } = require('electron');
const path = require('path');
const { createFileControls } = require('./lib/file-controls.cjs');
const { createEditorView, destroyEditorView, openSearch, getEditorLanguageName } = require('./dist/editor.bundle');
const { createEpubView, destroyEpubView } = require('./dist/epub.bundle');

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl']);
const SUPPORTED_EXTS = new Set([...TEXT_EXTS, '.epub']);
const EPUB_PROGRESS_KEY = 'moth-epub-progress-v1';
const MAX_SAVED_BOOKS = 50;

function fileKind(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.epub') return 'epub';
  return 'text';
}

const state = {
  tabs: [],
  activeTab: null,
  rootDir: null,
  tabSequence: 0,
  recentFiles: [],
  closedTabs: []
};

const $ = (selector) => document.querySelector(selector);
const $tabs = $('#tabs');
const $content = $('#content');
const $sidebar = $('#sidebar');
const $fileSidebar = $('#file-sidebar');
const $epubSidebar = $('#epub-sidebar');
const $fileTree = $('#file-tree');
const $folderName = $('#folder-name');
const $epubTitle = $('#epub-book-title');
const $epubToc = $('#epub-toc');
const $epubProgress = $('#epub-progress-label');
const $epubPrev = $('#btn-epub-prev');
const $epubNext = $('#btn-epub-next');
const $statusPath = $('#status-path');
const $statusStats = $('#status-stats');

const defaults = { font: 'Lexend, sans-serif', fontSize: 16, padding: 50, spacing: 100 };
const settings = { ...defaults, ...readStoredObject('md-settings') };
const epubPositions = readStoredObject(EPUB_PROGRESS_KEY);
let discardPromptInFlight = false;
let windowClosePromptPending = false;
let workspaceInitialized = false;
let workspaceClosing = false;
let workspaceCommitting = false;
let sessionTimer = null;
let sessionMaxTimer = null;
let sessionWrite = Promise.resolve(true);
let externalCheckPending = false;
let errorNotice = null;
let recoveryNotice = null;
const fileControls = createFileControls({ onCommand: runFileCommand });

function readStoredObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function nextTabId() {
  state.tabSequence += 1;
  return `tab-${Date.now()}-${state.tabSequence}`;
}

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTab) || null;
}

function sameFile(a, b) {
  if (!a || !b) return a === b;
  const ra = path.resolve(a), rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function isOpenTab(tab) {
  return Boolean(tab) && !tab.closed && state.tabs.includes(tab);
}

function dirtyTextTabs() {
  return state.tabs.filter((tab) => tab.kind === 'text' && tab.dirty && !tab.closed);
}

async function requestDecision(channel, ...details) {
  const result = await ipcRenderer.invoke(channel, ...details);
  return result?.prompt ? fileControls.confirm(result.prompt) : result;
}

async function confirmDiscardChanges(tabs, scope = 'tab') {
  const dirtyTabs = tabs.filter((tab) => isOpenTab(tab) && tab.kind === 'text' && tab.dirty);
  if (!dirtyTabs.length) return 'discard';
  if (discardPromptInFlight) return 'cancel';
  discardPromptInFlight = true;
  try {
    const decision = await requestDecision('confirm-discard-changes', {
      scope, count: dirtyTabs.length, names: dirtyTabs.map((tab) => tab.name)
    });
    return ['save', 'discard'].includes(decision) ? decision : 'cancel';
  } catch { return 'cancel'; }
  finally { discardPromptInFlight = false; }
}

function updateFileControls() {
  syncFileMenuPosition();
  const tab = activeTab();
  fileControls.update({
    canSave: tab?.kind === 'text',
    canSaveAll: state.tabs.some(t => t.kind === 'text' && t.dirty),
    canReload: Boolean(tab?.kind === 'text' && tab.path),
    canReopen: state.closedTabs.length > 0,
    recentFiles: state.recentFiles
  });
}

function showFileError(operation, filePath, error = {}) {
  error ||= {};
  const code = error.code || 'ERROR';
  const message = error.message || 'The operation could not be completed.';
  errorNotice = { message: `${operation}: ${filePath || 'Moth'} — ${message} (${code})`, kind: 'error' };
  renderDocumentNotice();
}

function renderDocumentNotice() {
  const tab = activeTab();
  if (errorNotice) {
    fileControls.showNotice({ ...errorNotice, actions: [
      ...(errorNotice.actions || []),
      { label: 'Dismiss', icon: 'close', onClick: () => { errorNotice = null; renderDocumentNotice(); } }
    ] });
  } else if (tab?.external && tab.ignoredExternalVersion !== (tab.external.version || 'missing')) {
    fileControls.showNotice({
      kind: 'external',
      message: tab.external.exists ? 'Changed on disk · your text is kept' : 'Missing on disk · your text is kept',
      actions: [
        ...(tab.external.exists ? [{ label: 'Reload from disk', icon: 'reload', onClick: () => reloadTab(tab) }] : []),
        { label: 'Save As', icon: 'save-as', onClick: () => saveTab(tab, { saveAs: true }) },
        { label: 'Keep current text', icon: 'close', onClick: () => { tab.ignoredExternalVersion = tab.external.version || 'missing'; renderDocumentNotice(); } }
      ]
    });
  } else if (recoveryNotice) {
    fileControls.showNotice({ kind: 'recovery', message: recoveryNotice, actions: [
      { label: 'Dismiss', icon: 'close', onClick: () => { recoveryNotice = null; renderDocumentNotice(); } }
    ] });
  } else fileControls.clearNotice();
}

async function runFileCommand(command, payload) {
  try {
    if (command === 'new') newFile();
    else if (command === 'open') await chooseFile();
    else if (command === 'open-folder') await chooseFolder();
    else if (command === 'save') await saveActiveTab();
    else if (command === 'save-as') await saveAsActiveTab();
    else if (command === 'save-all') await saveAllTabs();
    else if (command === 'reload') await reloadTab(activeTab());
    else if (command === 'reopen') await reopenClosedTab();
    else if (command === 'open-recent') await openFile(payload);
    else if (command === 'clear-recent') { state.recentFiles = []; updateFileControls(); scheduleSession(); }
  } catch (error) { showFileError('Could not complete action', '', error); }
}

function rememberFile(filePath) {
  if (!filePath || !workspaceInitialized) return;
  state.recentFiles = [{ path: filePath, name: path.basename(filePath) },
    ...state.recentFiles.filter(entry => !sameFile(entry.path, filePath))].slice(0, 20);
  updateFileControls();
  scheduleSession();
}

function applyDiskState(tab, result) {
  tab.diskVersion = result.version;
  tab.identity = result.identity;
  tab.realPath = result.realPath;
  tab.external = null;
  tab.ignoredExternalVersion = null;
}

function otherOpenTarget(tab, targetPath, status = {}) {
  return state.tabs.find(other => other !== tab && other.path && (
    sameFile(other.path, targetPath)
    || (status.identity && other.identity === status.identity)
    || (status.realPath && other.realPath && sameFile(status.realPath, other.realPath))
  ));
}

// --- File Tree ---

async function openFolder(dirPath) {
  if (!dirPath) return;
  state.rootDir = dirPath;
  $folderName.textContent = path.basename(dirPath);
  $folderName.title = dirPath;
  $fileTree.replaceChildren();
  await renderTree(dirPath, $fileTree, 0);
  scheduleSession();
}

async function renderTree(dirPath, container, depth) {
  const result = await ipcRenderer.invoke('read-dir', dirPath);
  if (!result?.ok) { showFileError('Could not open folder', dirPath, result); return; }
  for (const entry of result.entries) {
    const item = document.createElement('div');
    const row = document.createElement('div');
    row.className = `tree-item${entry.isDir ? ' dir' : ''}`;
    row.style.paddingLeft = `${10 + depth * 16}px`;
    row.dataset.path = entry.path;
    row.title = entry.path;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = entry.isDir ? '▸' : fileIcon(entry.ext);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;

    row.append(icon, name);
    item.appendChild(row);

    if (entry.isDir) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      item.appendChild(children);
      let loaded = false;

      row.addEventListener('click', async () => {
        const wasOpen = children.classList.contains('open');
        children.classList.toggle('open');
        icon.textContent = wasOpen ? '▸' : '▾';
        if (!loaded) {
          loaded = true;
          await renderTree(entry.path, children, depth + 1);
        }
      });
    } else if (SUPPORTED_EXTS.has(entry.ext)) {
      row.addEventListener('click', () => openFile(entry.path));
    } else {
      row.style.color = '#555';
    }

    if (!entry.isDir) {
      row.addEventListener('contextmenu', async (event) => {
        event.preventDefault();
        const nameSpan = row.querySelector('.name');
        if (!nameSpan) return;
        const input = await renameFile(entry.path, entry.name, (result) => {
          if (result) {
            const tab = state.tabs.find((candidate) => sameFile(candidate.path, entry.path));
            if (tab) updateTabPath(tab, result.newPath, result.newName);
            entry.path = result.newPath;
            entry.name = result.newName;
            entry.ext = path.extname(result.newName).toLowerCase();
            row.dataset.path = result.newPath;
            row.title = result.newPath;
            icon.textContent = fileIcon(entry.ext);
          }
          const replacement = document.createElement('span');
          replacement.className = 'name';
          replacement.textContent = entry.name;
          const existing = row.querySelector('.rename-input');
          if (existing) existing.replaceWith(replacement);
        });
        nameSpan.replaceWith(input);
      });
    }
    container.appendChild(item);
  }
}

async function renameFile(oldPath, oldName, onDone) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = oldName;

  const dotIndex = oldName.lastIndexOf('.');
  requestAnimationFrame(() => {
    input.focus();
    if (dotIndex > 0) input.setSelectionRange(0, dotIndex);
    else input.select();
  });

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      onDone(null);
      return;
    }
    if (path.basename(newName) !== newName || newName === '.' || newName === '..') {
      showFileError('Could not rename', oldPath, { code: 'INVALID_NAME', message: 'Enter a filename without folder separators.' });
      onDone(null); return;
    }
    const newPath = path.join(path.dirname(oldPath), newName);
    if (fileKind(oldPath) !== fileKind(newPath)) {
      showFileError('Could not rename', newPath, { code: 'FILE_TYPE', message: 'Keep the current file type, or use Save As for another text format.' });
      onDone(null);
      return;
    }
    const sourceTab = state.tabs.find(t => sameFile(t.path, oldPath));
    const target = await ipcRenderer.invoke('file-status', newPath);
    if (otherOpenTarget(sourceTab, newPath, target)) {
      showFileError('Could not rename', newPath, { code: 'FILE_OPEN', message: 'That file is already open in another tab. Choose another name.' });
      onDone(null); return;
    }
    const result = await ipcRenderer.invoke('rename-file', oldPath, newPath, sourceTab?.kind === 'text' ? { expectedVersion: sourceTab.diskVersion } : {});
    if (!result?.ok) {
      showFileError('Could not rename', newPath, result?.code === 'EEXIST' ? { ...result, message: 'A file already uses this name. Choose another name; neither file was replaced.' } : result);
      onDone(null); return;
    }
    if (sourceTab) applyDiskState(sourceTab, result);
    state.recentFiles = state.recentFiles.filter(entry => !sameFile(entry.path, oldPath));
    onDone({ newPath, newName });
    rememberFile(newPath);
  }

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      committed = true;
      onDone(null);
    }
  });
  input.addEventListener('blur', commit);
  // Inline rename lives inside clickable tabs/tree rows. A click in the input
  // must not reopen the file and move keyboard focus back to its editor.
  input.addEventListener('click', (event) => event.stopPropagation());
  return input;
}

function fileIcon(ext) {
  if (ext === '.epub') return '▧';
  if (ext === '.json' || ext === '.jsonl') return '{}';
  if (TEXT_EXTS.has(ext)) return '◇';
  if (ext === '.pdf') return '▪';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext)) return '▪';
  return '·';
}

// --- Tabs and files ---

async function openFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const existing = state.tabs.find((tab) => sameFile(tab.path, filePath));
  if (existing) {
    activateTab(existing.id); rememberFile(filePath); await checkExternalChanges(); return true;
  }
  if (path.extname(filePath).toLowerCase() === '.epub') {
    await openEpubFile(filePath); rememberFile(filePath); return true;
  }
  const result = await ipcRenderer.invoke('read-file', filePath);
  if (!result?.ok) { showFileError('Could not open file', filePath, result); return false; }
  const alias = otherOpenTarget(null, filePath, result);
  if (alias) { activateTab(alias.id); rememberFile(alias.path); return true; }
  const tab = createTextTab(path.basename(filePath), filePath, result.content);
  applyDiskState(tab, result);
  state.tabs.push(tab);
  errorNotice = null;
  renderTabs(); activateTab(tab.id); rememberFile(filePath);
  return true;
}

function createTextTab(name, filePath, content) {
  return {
    kind: 'text',
    id: nextTabId(),
    path: filePath,
    name,
    content,
    savedContent: content,
    diskVersion: null,
    identity: null,
    realPath: null,
    external: null,
    dirty: false,
    editorView: null,
    closed: false
  };
}

async function openEpubFile(filePath) {
  const host = document.createElement('div');
  host.className = 'epub-tab-host';
  showEpubHostState(host, 'loading', 'Opening book…');

  const tab = {
    kind: 'epub',
    id: nextTabId(),
    path: filePath,
    name: path.basename(filePath),
    dirty: false,
    closed: false,
    host,
    epubView: null,
    toc: [],
    metadata: null,
    signature: null,
    cfi: null,
    href: null,
    chapter: '',
    percentage: null,
    atStart: true,
    atEnd: false,
    locationStatus: 'loading',
    error: null
  };

  state.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
  $sidebar.classList.remove('collapsed');

  const result = await ipcRenderer.invoke('read-epub', filePath);
  if (!isOpenTab(tab)) return;
  if (!result || !result.ok || !result.data) {
    tab.locationStatus = 'error';
    tab.error = `Could not read this EPUB${result && result.code ? ` (${result.code})` : ''}.`;
    showEpubHostState(tab.host, 'error', tab.error);
    refreshActiveEpubUi(tab);
    return;
  }

  tab.signature = `${result.size}:${Math.trunc(result.mtimeMs)}`;
  const savedPosition = epubPositions[progressKey(tab.path)];
  const initialCfi = savedPosition && savedPosition.signature === tab.signature
    ? savedPosition.cfi
    : null;

  tab.host.replaceChildren();
  try {
    tab.epubView = createEpubView(tab.host, result.data, {
      settings: { ...settings },
      initialCfi,
      onToc: (toc) => {
        if (!isOpenTab(tab)) return;
        tab.toc = Array.isArray(toc) ? toc : [];
        if (tab.id === state.activeTab) renderEpubToc(tab);
      },
      onReady: ({ metadata, toc } = {}) => {
        if (!isOpenTab(tab)) return;
        tab.metadata = metadata || tab.metadata;
        if (Array.isArray(toc)) tab.toc = toc;
        tab.locationStatus = tab.locationStatus === 'loading' ? 'ready' : tab.locationStatus;
        refreshActiveEpubUi(tab, true);
      },
      onRelocated: (location = {}) => {
        // Hidden EPUB iframes can emit transient locations while their views
        // collapse or refill. Only the visible book may commit reading state;
        // activation triggers a final resize/report for the real location.
        if (!isOpenTab(tab) || tab.id !== state.activeTab) return;
        tab.cfi = location.cfi || tab.cfi;
        tab.href = location.href || tab.href;
        const chapter = location.chapter;
        tab.chapter = (chapter && typeof chapter === 'object' ? chapter.label : chapter) || tab.chapter;
        if (Number.isFinite(location.percentage)) tab.percentage = location.percentage;
        tab.atStart = Boolean(location.atStart);
        tab.atEnd = Boolean(location.atEnd);
        saveEpubPosition(tab);
        refreshActiveEpubUi(tab);
      },
      onProgress: (progress = {}) => {
        if (!isOpenTab(tab)) return;
        if (progress.status === 'generating' || progress.status === 'ready') {
          tab.locationStatus = progress.status;
        } else if (progress.status === 'error') {
          tab.locationStatus = 'ready';
          tab.progressError = true;
        }
        if (Number.isFinite(progress.percentage) && tab.percentage === null) {
          tab.percentage = progress.percentage;
        }
        refreshActiveEpubUi(tab);
      },
      onError: (error = {}) => {
        if (!isOpenTab(tab)) return;
        if (error.fatal) tab.locationStatus = 'error';
        tab.error = error.message || 'This EPUB could not be opened.';
        refreshActiveEpubUi(tab);
      }
    });

    tab.epubView.ready
      .then(() => {
        if (isOpenTab(tab) && tab.id === state.activeTab) {
          requestAnimationFrame(() => tab.epubView && tab.epubView.resize());
        }
      })
      .catch(() => {
        if (isOpenTab(tab)) refreshActiveEpubUi(tab);
      });
  } catch (error) {
    tab.locationStatus = 'error';
    tab.error = error && error.message ? error.message : 'This EPUB could not be opened.';
    showEpubHostState(tab.host, 'error', tab.error);
    refreshActiveEpubUi(tab);
  }
}

function showEpubHostState(host, kind, message) {
  const stateElement = document.createElement('div');
  stateElement.className = kind === 'error' ? 'epub-error' : 'epub-loading';
  if (kind === 'error') {
    const title = document.createElement('strong');
    title.textContent = 'Unable to open book';
    const detail = document.createElement('span');
    detail.textContent = message;
    stateElement.append(title, detail);
  } else {
    stateElement.textContent = message;
  }
  host.replaceChildren(stateElement);
}

function activateTab(id) {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab) return;

  const previous = activeTab();
  if (previous && previous.id !== id) detachTab(previous);
  state.activeTab = id;

  document.querySelectorAll('.tab').forEach((element) => {
    element.classList.toggle('active', element.dataset.id === id);
  });
  document.querySelectorAll('.tree-item').forEach((element) => {
    element.classList.toggle('active', sameFile(element.dataset.path, tab.path));
  });

  renderContent(tab);
  if (tab.kind === 'text' && tab.editorView
    && !tab.editorView.dom.contains(document.activeElement)
    && !document.activeElement?.matches('.rename-input')) {
    tab.editorView.focus();
  }
  renderSidebar(tab);
  $statusPath.textContent = tab.path || '';
  updateStatusBar(tab);
  ensureActiveTabVisible();
  updateFileControls();
  renderDocumentNotice();
  scheduleSession();
  if (workspaceInitialized) checkExternalChanges().catch(() => {});
}

function detachTab(tab) {
  if (tab.kind === 'text' && tab.editorView) tab.viewState = editorPosition(tab);
  if (tab.kind === 'text' && tab.editorView) tab.editorView.dom.remove();
  if (tab.kind === 'epub' && tab.host) {
    tab.host.classList.add('is-hidden');
    tab.host.setAttribute('aria-hidden', 'true');
  }
}

async function closeTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || tab.closePromptPending || workspaceCommitting) return false;
  tab.closePromptPending = true;
  let decision = 'save';
  let froze = false;
  try {
    if (tab.kind === 'text' && tab.dirty) {
      decision = await confirmDiscardChanges([tab]);
      if (decision === 'cancel' || !isOpenTab(tab)) return false;
      if (decision === 'save' && (!(await saveTab(tab)) || tab.dirty)) return false;
    }
    const history = tab.path ? [{ path: tab.path, name: tab.name },
      ...state.closedTabs.filter(entry => !sameFile(entry.path, tab.path))].slice(0, 20) : state.closedTabs;
    const contentBeforeClose = tab.content;
    workspaceCommitting = true; $('#app').inert = true; froze = true;
    const committed = await flushSession({ excludeTabIds: [tab.id], closedTabs: history, discardPrevious: decision === 'discard' });
    if (!committed) return false;
    if (tab.content !== contentBeforeClose || !isOpenTab(tab)) {
      await flushSession(); return false;
    }
    const index = state.tabs.indexOf(tab), wasActive = state.activeTab === id;
    state.closedTabs = history;
    tab.closed = true;
    if (tab.kind === 'text' && tab.editorView) {
      destroyEditorView(tab.editorView); tab.editorView = null;
    } else if (tab.kind === 'epub') {
      if (tab.epubView) destroyEpubView(tab.epubView);
      tab.epubView = null; tab.host.remove();
    }
    state.tabs.splice(index, 1);
    if (wasActive) state.activeTab = null;
    renderTabs();
    if (wasActive) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)];
      if (next) activateTab(next.id); else renderEmptyState();
    } else ensureActiveTabVisible();
    return true;
  } finally {
    tab.closePromptPending = false;
    if (froze) {
      workspaceCommitting = false; $('#app').inert = false;
      activeTab()?.editorView?.focus(); scheduleSession();
    }
  }
}

function renderTabs() {
  const oldScrollLeft = $tabs.scrollLeft;
  const fragment = document.createDocumentFragment();

  for (const tab of state.tabs) {
    const element = document.createElement('div');
    element.className = `tab${tab.id === state.activeTab ? ' active' : ''}`;
    element.dataset.id = tab.id;
    element.title = tab.path || tab.name;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = `${tab.dirty ? '● ' : ''}${tab.name}`;

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = `Close ${tab.name}`;
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    element.append(title, close);
    element.addEventListener('click', () => activateTab(tab.id));
    element.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      if (!tab.path) return;
      const oldPath = tab.path;
      const input = await renameFile(tab.path, tab.name, (result) => {
        if (result) {
          const treeItem = Array.from(document.querySelectorAll('.tree-item'))
            .find((item) => sameFile(item.dataset.path, oldPath));
          updateTabPath(tab, result.newPath, result.newName);
          if (treeItem) {
            treeItem.dataset.path = result.newPath;
            treeItem.title = result.newPath;
            const nameSpan = treeItem.querySelector('.name');
            if (nameSpan) nameSpan.textContent = result.newName;
            const icon = treeItem.querySelector('.icon');
            if (icon) icon.textContent = fileIcon(path.extname(result.newName).toLowerCase());
          }
        } else {
          renderTabs();
        }
      });
      title.textContent = '';
      title.appendChild(input);
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    fragment.appendChild(element);
  }

  $tabs.replaceChildren(fragment);
  $tabs.scrollLeft = oldScrollLeft;
  ensureActiveTabVisible();
  updateFileControls();
  scheduleSession();
}

function updateTabPath(tab, newPath, newName) {
  const oldPath = tab.path;
  const oldExt = path.extname(oldPath || tab.name).toLowerCase();
  const newExt = path.extname(newPath || newName).toLowerCase();
  tab.path = newPath;
  tab.name = newName;
  if (tab.kind === 'epub') migrateEpubPosition(oldPath, newPath);
  if (tab.kind === 'text' && oldExt !== newExt) rebuildTextEditor(tab);
  renderTabs();
  if (tab.id === state.activeTab) {
    $statusPath.textContent = newPath;
    updateStatusBar(tab);
  }
}

function rebuildTextEditor(tab) {
  const view = tab.editorView;
  if (!view) return;

  const selection = view.state.selection.main;
  tab.pendingEditorRestore = {
    anchor: selection.anchor,
    head: selection.head,
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
    focused: view.hasFocus
  };
  const editorDom = view.dom;
  destroyEditorView(view);
  editorDom.remove();
  tab.editorView = null;

  if (tab.id === state.activeTab) renderContent(tab);
}

function restoreTextEditorState(tab) {
  const restore = tab.pendingEditorRestore;
  const view = tab.editorView;
  if (!restore || !view) return;
  delete tab.pendingEditorRestore;

  const documentLength = view.state.doc.length;
  view.dispatch({
    selection: {
      anchor: Math.min(documentLength, restore.anchor),
      head: Math.min(documentLength, restore.head)
    }
  });
  requestAnimationFrame(() => {
    if (tab.editorView !== view) return;
    view.scrollDOM.scrollTop = restore.scrollTop;
    view.scrollDOM.scrollLeft = restore.scrollLeft;
    if (restore.focused) view.focus();
  });
}

function ensureActiveTabVisible() {
  requestAnimationFrame(() => {
    const element = $tabs.querySelector(`.tab[data-id="${state.activeTab}"]`);
    if (!element) return;
    const tabRect = element.getBoundingClientRect();
    const containerRect = $tabs.getBoundingClientRect();
    if (tabRect.left < containerRect.left) {
      $tabs.scrollLeft -= containerRect.left - tabRect.left;
    } else if (tabRect.right > containerRect.right) {
      $tabs.scrollLeft += tabRect.right - containerRect.right;
    }
  });
}

// --- Text editor and EPUB content ---

function renderContent(tab) {
  const welcome = $content.querySelector('#welcome');
  if (welcome) welcome.remove();
  for (const candidate of state.tabs) {
    if (candidate.kind !== 'epub' || !candidate.host) continue;
    const isActive = candidate.id === tab.id;
    candidate.host.classList.toggle('is-hidden', !isActive);
    if (isActive) candidate.host.removeAttribute('aria-hidden');
    else candidate.host.setAttribute('aria-hidden', 'true');
  }

  if (tab.kind === 'epub') {
    if (tab.host.parentElement !== $content) $content.appendChild(tab.host);
    // Reading views may queue a stale relocation as soon as display:none is
    // removed. Start the guarded resize immediately so it cannot overwrite the
    // last committed chapter before the next animation frame.
    if (tab.epubView) tab.epubView.resize();
    return;
  }

  if (!tab.editorView) {
    tab.editorView = createEditorView($content, tab.content, {
      onChange: (newContent) => {
        tab.content = newContent;
        const wasDirty = tab.dirty;
        tab.dirty = newContent !== tab.savedContent;
        if (wasDirty !== tab.dirty) renderTabs();
        if (tab.id === state.activeTab) updateStatusBar(tab);
        updateFileControls();
        scheduleSession();
      },
      fileExt: path.extname(tab.name).toLowerCase()
    });
    restoreTextEditorState(tab);
  } else {
    // Re-appending an already active editor blurs its search/replace inputs.
    if (tab.editorView.dom.parentElement !== $content) {
      $content.appendChild(tab.editorView.dom);
      // Removing the editor DOM resets its scroll container. Restore this tab's
      // position before layout measurement and focus, including rapid switches
      // that happen before the next animation frame.
      if (tab.viewState) {
        tab.editorView.scrollDOM.scrollTop = tab.viewState.scrollTop;
        tab.editorView.scrollDOM.scrollLeft = tab.viewState.scrollLeft;
      }
    }
    tab.editorView.requestMeasure();
  }
}

function renderEmptyState() {
  state.activeTab = null;
  $content.innerHTML = '<div id="welcome"><h2>Moth</h2><p>Open a folder, document, or EPUB to get started.</p></div>';
  $statusPath.textContent = '';
  $statusStats.textContent = '';
  renderSidebar(null);
  updateFileControls();
  renderDocumentNotice();
  scheduleSession();
}

function updateStatusBar(tab) {
  if (tab.kind === 'epub') {
    if (tab.locationStatus === 'error') {
      $statusStats.textContent = 'EPUB · unable to open';
      return;
    }
    const percent = Number.isFinite(tab.percentage) ? `${Math.round(tab.percentage * 100)}%` : null;
    const chapter = tab.chapter || (tab.metadata && tab.metadata.title) || 'EPUB';
    $statusStats.textContent = [chapter, percent].filter(Boolean).join(' · ');
    return;
  }
  const words = tab.content.trim().split(/\s+/).filter(Boolean).length;
  const chars = tab.content.length;
  $statusStats.textContent = `${words} words · ${chars} characters`;
}

async function reportWriteFailure(tab, filePath, result) {
  const code = result?.code || 'WRITE_FAILED';
  let guidance = 'Check the location or choose Save As.';
  if (code === 'ENOENT' || code === 'ENOTDIR') guidance = 'The destination folder is missing or unavailable. Restore it or choose Save As.';
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) guidance = 'This location is not writable. Choose Save As or check permissions.';
  if (['ENOSPC', 'EDQUOT'].includes(code)) guidance = 'The destination has no space available. Free space or choose Save As.';
  errorNotice = {
    kind: 'error', message: `Could not save ${filePath}. ${guidance} (${code}) Your changes are still open.`,
    actions: [{ label: 'Save As', icon: 'save-as', onClick: () => saveTab(tab, { saveAs: true }) }]
  };
  renderDocumentNotice();
  return false;
}

async function performSave(tab, { saveAs = false } = {}) {
  if (!isOpenTab(tab) || tab.kind !== 'text') return false;
  if (!saveAs && tab.path && !tab.dirty) return true;
  let targetPath = tab.path;
  if (saveAs || !targetPath) {
    targetPath = await ipcRenderer.invoke('save-file-dialog', tab.path || tab.name);
    if (!targetPath || !isOpenTab(tab)) return false;
  }
  if (fileKind(targetPath) === 'epub') {
    showFileError('Could not save text', targetPath, { code: 'FILE_TYPE', message: 'Choose a text filename instead of an EPUB book.' });
    return false;
  }
  const status = await ipcRenderer.invoke('file-status', targetPath);
  if (!status?.ok) return reportWriteFailure(tab, targetPath, status);
  if (otherOpenTarget(tab, targetPath, status)) {
    showFileError('Could not save', targetPath, { code: 'FILE_OPEN', message: 'This destination is open in another tab. Choose another filename to keep both documents safe.' });
    return false;
  }
  const sameTarget = tab.path && (sameFile(tab.path, targetPath)
    || (tab.realPath && sameFile(tab.realPath, status.realPath))
    || (tab.identity && tab.identity === status.identity));
  if (!sameTarget && status.exists && !(await requestDecision('confirm-overwrite', targetPath))) return false;
  let expectedVersion = sameTarget ? tab.diskVersion : status.version;
  for (let attempt = 0; attempt < 4; attempt++) {
    const contentToSave = tab.content;
    let result;
    try { result = await ipcRenderer.invoke('write-file', targetPath, contentToSave, { expectedVersion }); }
    catch (error) { result = { ok: false, code: 'WRITE_FAILED', message: error.message }; }
    if (result?.ok) {
      if (!isOpenTab(tab)) return false;
      tab.savedContent = contentToSave;
      tab.dirty = tab.content !== contentToSave;
      applyDiskState(tab, result);
      if (!sameFile(tab.path, targetPath)) updateTabPath(tab, targetPath, path.basename(targetPath));
      errorNotice = null;
      renderTabs(); renderDocumentNotice(); rememberFile(targetPath);
      if (tab.id === state.activeTab) $statusPath.textContent = tab.path;
      await flushSession();
      return true;
    }
    if (result?.code !== 'FILE_CHANGED') return reportWriteFailure(tab, targetPath, result);
    tab.external = { exists: result.currentVersion !== null, version: result.currentVersion };
    renderDocumentNotice();
    const allowReload = sameFile(targetPath, tab.path);
    const choice = await requestDecision('confirm-file-conflict', { path: targetPath, allowReload });
    if (choice === 'save-as') return performSave(tab, { saveAs: true });
    if (choice === 'reload') { if (allowReload) await reloadTab(tab); return false; }
    if (choice !== 'overwrite') return false;
    expectedVersion = result.currentVersion;
  }
  showFileError('Could not save', targetPath, { code: 'FILE_CHANGED', message: 'The file keeps changing outside Moth. Choose Save As to keep your edits separately.' });
  return false;
}

async function saveTab(tab, options = {}) {
  if (!tab || tab.kind !== 'text') return false;
  if (tab.savePromise) return tab.savePromise;
  tab.savePromise = performSave(tab, options);
  try { return await tab.savePromise; }
  finally { tab.savePromise = null; updateFileControls(); }
}

async function saveActiveTab() { return saveTab(activeTab()); }
async function saveAsActiveTab() { return saveTab(activeTab(), { saveAs: true }); }

async function saveAllTabs() {
  for (const tab of [...state.tabs]) {
    if (tab.kind === 'text' && tab.dirty) {
      if (!(await saveTab(tab)) || tab.dirty) return false;
    }
  }
  return true;
}

async function reloadTab(tab) {
  if (!isOpenTab(tab) || tab.kind !== 'text' || !tab.path) return false;
  if (tab.dirty && !(await requestDecision('confirm-reload', tab.path))) return false;
  const result = await ipcRenderer.invoke('read-file', tab.path);
  if (!result?.ok) { showFileError('Could not reload', tab.path, result); return false; }
  tab.savedContent = result.content;
  if (tab.editorView) tab.editorView.dispatch({ changes: { from: 0, to: tab.editorView.state.doc.length, insert: result.content } });
  tab.content = result.content; tab.dirty = false;
  applyDiskState(tab, result); errorNotice = null;
  renderTabs(); renderDocumentNotice();
  if (tab.id === state.activeTab) updateStatusBar(tab);
  await flushSession();
  return true;
}

async function checkExternalChanges() {
  if (!workspaceInitialized || externalCheckPending || workspaceClosing) return;
  const tab = activeTab();
  if (!tab?.path || tab.kind !== 'text' || tab.savePromise) return;
  externalCheckPending = true;
  const version = tab.diskVersion, checkedPath = tab.path;
  try {
    const result = await ipcRenderer.invoke('file-status', checkedPath);
    if (!isOpenTab(tab) || tab.path !== checkedPath || tab.diskVersion !== version || tab.savePromise) return;
    if (!result?.ok) { showFileError('Could not check file', checkedPath, result); return; }
    tab.external = result.version !== tab.diskVersion || !result.exists ? result : null;
    if (tab.id === state.activeTab) renderDocumentNotice();
  } finally { externalCheckPending = false; }
}

async function reopenClosedTab() {
  const entry = state.closedTabs[0];
  if (!entry) return false;
  if (!(await openFile(entry.path))) return false;
  state.closedTabs.shift(); updateFileControls(); scheduleSession(); return true;
}

// --- EPUB sidebar and progress ---

function renderSidebar(tab) {
  const isEpub = tab && tab.kind === 'epub';
  $fileSidebar.classList.toggle('hidden', isEpub);
  $epubSidebar.classList.toggle('hidden', !isEpub);
  syncFileMenuPosition();
  if (isEpub) {
    renderEpubToc(tab);
    syncEpubSidebar(tab);
  }
}

function renderEpubToc(tab) {
  $epubToc.replaceChildren();
  if (!tab.toc.length) {
    const empty = document.createElement('div');
    empty.className = 'epub-toc-empty';
    empty.textContent = tab.locationStatus === 'loading' ? 'Loading contents…' : 'No table of contents';
    $epubToc.appendChild(empty);
    return;
  }
  $epubToc.appendChild(buildTocList(tab, tab.toc, 0));
  updateActiveTocItem(tab);
}

function buildTocList(tab, items, depth) {
  const list = document.createElement('ul');
  list.className = 'epub-toc-list';
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'epub-toc-item';
    const button = document.createElement('button');
    const label = String(item.label || item.title || 'Untitled chapter').trim();
    button.type = 'button';
    button.textContent = label;
    button.title = label;
    button.dataset.href = item.href || '';
    button.addEventListener('click', () => {
      if (tab.epubView && item.href) tab.epubView.goChapter(item.href).catch(() => {});
    });
    row.appendChild(button);
    const children = item.subitems || item.children;
    if (depth < 12 && Array.isArray(children) && children.length) {
      row.appendChild(buildTocList(tab, children, depth + 1));
    }
    list.appendChild(row);
  }
  return list;
}

function syncEpubSidebar(tab) {
  const title = tab.metadata && tab.metadata.title ? tab.metadata.title : tab.name;
  $epubTitle.textContent = title;
  $epubTitle.title = title;

  if (tab.locationStatus === 'error') {
    $epubProgress.textContent = tab.error || 'Unable to open this EPUB';
  } else if (tab.locationStatus === 'generating') {
    $epubProgress.textContent = 'Preparing reading progress…';
  } else {
    const percent = Number.isFinite(tab.percentage) ? `${Math.round(tab.percentage * 100)}%` : 'Opening…';
    $epubProgress.textContent = tab.chapter ? `${tab.chapter} · ${percent}` : percent;
  }
  $epubPrev.disabled = !tab.epubView || tab.atStart || tab.locationStatus === 'error';
  $epubNext.disabled = !tab.epubView || tab.atEnd || tab.locationStatus === 'error';
  updateActiveTocItem(tab);
}

function updateActiveTocItem(tab) {
  $epubToc.querySelectorAll('button[data-href]').forEach((button) => {
    button.classList.toggle('active', hrefMatches(button.dataset.href, tab.href));
  });
}

function hrefMatches(a, b) {
  if (!a || !b) return false;
  const clean = (value) => decodeURIComponent(String(value).split('#')[0]).replace(/\\/g, '/');
  try {
    const left = clean(a);
    const right = clean(b);
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  } catch {
    return String(a).split('#')[0] === String(b).split('#')[0];
  }
}

function refreshActiveEpubUi(tab, rerenderToc = false) {
  if (tab.id !== state.activeTab) return;
  if (rerenderToc) renderEpubToc(tab);
  syncEpubSidebar(tab);
  updateStatusBar(tab);
}

function progressKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function saveEpubPosition(tab) {
  if (!tab.path || !tab.signature || !tab.cfi) return;
  epubPositions[progressKey(tab.path)] = {
    signature: tab.signature,
    cfi: tab.cfi,
    percentage: tab.percentage,
    updatedAt: Date.now()
  };
  trimEpubPositions();
  localStorage.setItem(EPUB_PROGRESS_KEY, JSON.stringify(epubPositions));
}

function migrateEpubPosition(oldPath, newPath) {
  if (!oldPath || !newPath) return;
  const oldKey = progressKey(oldPath);
  const newKey = progressKey(newPath);
  if (epubPositions[oldKey]) {
    epubPositions[newKey] = epubPositions[oldKey];
    delete epubPositions[oldKey];
    localStorage.setItem(EPUB_PROGRESS_KEY, JSON.stringify(epubPositions));
  }
}

function trimEpubPositions() {
  const entries = Object.entries(epubPositions);
  if (entries.length <= MAX_SAVED_BOOKS) return;
  entries
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(MAX_SAVED_BOOKS)
    .forEach(([key]) => delete epubPositions[key]);
}

// --- New file and controls ---

let untitledCount = 0;

function newFile() {
  untitledCount += 1;
  const name = untitledCount === 1 ? 'Untitled.md' : `Untitled-${untitledCount}.md`;
  const tab = createTextTab(name, null, '');
  state.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
}

$('#btn-new-file').addEventListener('click', newFile);

$('#btn-search').addEventListener('click', () => {
  const tab = activeTab();
  if (tab && tab.kind === 'text' && tab.editorView) openSearch(tab.editorView);
});

async function chooseFolder() {
  const dir = await ipcRenderer.invoke('open-folder');
  if (dir) await openFolder(dir);
}

async function chooseFile() {
  const file = await ipcRenderer.invoke('open-file-dialog');
  if (file) {
    if (!state.rootDir) await openFolder(path.dirname(file));
    await openFile(file);
  }
}

$epubPrev.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && tab.kind === 'epub' && tab.epubView) tab.epubView.goChapter('prev').catch(() => {});
});

$epubNext.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && tab.kind === 'epub' && tab.epubView) tab.epubView.goChapter('next').catch(() => {});
});

function prepareActiveEpubResize() {
  const tab = activeTab();
  if (tab && tab.kind === 'epub' && tab.epubView) tab.epubView.prepareResize?.();
}

function syncFileMenuPosition() {
  fileControls.setSidebarVisible(!$sidebar.classList.contains('collapsed')
    && !$fileSidebar.classList.contains('hidden'));
}

function toggleSidebar() {
  prepareActiveEpubResize();
  $sidebar.classList.toggle('collapsed');
  syncFileMenuPosition();
  scheduleSession();
}

$('#btn-toggle-sidebar').addEventListener('click', toggleSidebar);

const resizer = $('#sidebar-resize');
let isResizing = false;
resizer.addEventListener('mousedown', () => {
  prepareActiveEpubResize();
  isResizing = true;
  document.body.style.cursor = 'col-resize';
});
document.addEventListener('mousemove', (event) => {
  if (!isResizing) return;
  const width = Math.max(160, Math.min(500, event.clientX));
  $sidebar.style.width = `${width}px`;
});
document.addEventListener('mouseup', () => {
  isResizing = false;
  document.body.style.cursor = '';
  scheduleSession();
});

$tabs.addEventListener('wheel', (event) => {
  if ($tabs.scrollWidth <= $tabs.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  event.preventDefault();
  $tabs.scrollLeft += delta;
}, { passive: false });

document.addEventListener('selectionchange', scheduleSession);
document.addEventListener('scroll', scheduleSession, true);

window.addEventListener('resize', () => {
  ensureActiveTabVisible();
  const tab = activeTab();
  if (tab && tab.kind === 'epub' && tab.epubView) tab.epubView.resize();
});

// --- Settings ---

function applySettings() {
  document.documentElement.style.setProperty('--md-font', settings.font);
  document.documentElement.style.setProperty('--md-font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--content-padding', `${settings.padding}px`);
  document.documentElement.style.setProperty('--md-spacing', settings.spacing / 100);
  $('#setting-font').value = settings.font;
  $('#setting-font-size').value = settings.fontSize;
  $('#setting-padding').value = settings.padding;
  $('#setting-spacing').value = settings.spacing;
  $('#font-size-val').textContent = `${settings.fontSize}px`;
  $('#padding-val').textContent = `${settings.padding}px`;
  $('#spacing-val').textContent = `${settings.spacing}%`;
  localStorage.setItem('md-settings', JSON.stringify(settings));

  for (const tab of state.tabs) {
    if (tab.kind === 'epub' && tab.epubView) {
      try {
        tab.epubView.applySettings({ ...settings }).catch(() => {});
      } catch {
        // A failed EPUB keeps its readable error state while settings continue to work elsewhere.
      }
    }
  }
  const tab = activeTab();
  if (tab && tab.kind === 'text' && tab.editorView) tab.editorView.requestMeasure();
}

$('#btn-settings').addEventListener('click', (event) => {
  event.stopPropagation();
  $('#settings-panel').classList.toggle('open');
});
document.addEventListener('click', (event) => {
  const panel = $('#settings-panel');
  if (panel.classList.contains('open') && !panel.contains(event.target)) panel.classList.remove('open');
});

$('#setting-font').addEventListener('change', (event) => {
  settings.font = event.target.value;
  applySettings();
});
$('#setting-font-size').addEventListener('input', (event) => {
  settings.fontSize = Number(event.target.value);
  applySettings();
});
$('#setting-padding').addEventListener('input', (event) => {
  settings.padding = Number(event.target.value);
  applySettings();
});
$('#setting-spacing').addEventListener('input', (event) => {
  settings.spacing = Number(event.target.value);
  applySettings();
});

applySettings();

// Recovery snapshots are separate from documents: autosaving a draft never
// writes the user's original file or changes its saved/dirty state.
function editorPosition(tab) {
  const view = tab.editorView;
  if (!view) return tab.viewState || null;
  if (tab.id !== state.activeTab && tab.viewState) return tab.viewState;
  const { anchor, head } = view.state.selection.main;
  return { anchor, head, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft };
}

function createSessionSnapshot({ discardDrafts = false, excludeTabIds = [], closedTabs = state.closedTabs } = {}) {
  const tabs = state.tabs.filter(tab => !tab.closed && !excludeTabIds.includes(tab.id) && !(discardDrafts && tab.kind === 'text' && !tab.path));
  return {
    version: 1, updatedAt: Date.now(),
    tabs: tabs.map(tab => {
      if (tab.kind === 'epub') return { kind: 'epub', path: tab.path, name: tab.name };
      return {
        kind: 'text', path: tab.path, name: tab.name,
        content: discardDrafts ? tab.savedContent : tab.content,
        savedContent: tab.savedContent,
        dirty: discardDrafts ? false : tab.dirty,
        diskVersion: tab.diskVersion, identity: tab.identity, realPath: tab.realPath,
        viewState: editorPosition(tab)
      };
    }),
    activeIndex: Math.max(0, tabs.findIndex(tab => tab.id === state.activeTab)),
    activePath: activeTab()?.path || null,
    rootDir: state.rootDir,
    sidebarCollapsed: $sidebar.classList.contains('collapsed'),
    sidebarWidth: $sidebar.style.width,
    recentFiles: state.recentFiles,
    closedTabs
  };
}

function scheduleSession() {
  if (!workspaceInitialized || workspaceClosing || workspaceCommitting) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { sessionTimer = null; flushSession(); }, 350);
  // Continuous typing still gets a durable checkpoint at least every two seconds.
  if (!sessionMaxTimer) sessionMaxTimer = setTimeout(flushSession, 2000);
}

function flushSession(options = {}) {
  clearTimeout(sessionTimer); sessionTimer = null;
  clearTimeout(sessionMaxTimer); sessionMaxTimer = null;
  if (!workspaceInitialized) return Promise.resolve(true);
  const snapshot = createSessionSnapshot(options);
  sessionWrite = sessionWrite.catch(() => false).then(async () => {
    try {
      const result = await ipcRenderer.invoke('write-session', snapshot, { discardPrevious: Boolean(options.discardPrevious || options.discardDrafts) });
      if (result?.ok) return true;
      showFileError('Could not save recovery data', '', result);
    } catch (error) { showFileError('Could not save recovery data', '', error); }
    return false;
  });
  return sessionWrite;
}

function ensureEditableWorkspace() {
  const textTab = activeTab()?.kind === 'text' ? activeTab() : state.tabs.find(tab => tab.kind === 'text');
  if (textTab) activateTab(textTab.id);
  else newFile();
  activeTab()?.editorView?.focus();
}

async function initializeWorkspace() {
  let recoveredCount = 0;
  try {
    const result = await ipcRenderer.invoke('read-session');
    const saved = result?.session;
    if (!result?.ok) showFileError('Could not restore the previous session', '', result);
    if (saved && saved.version === 1 && Array.isArray(saved.tabs)) {
      const history = list => Array.isArray(list) ? list.filter(entry => entry && typeof entry.path === 'string')
        .slice(0, 20).map(entry => ({ path: entry.path, name: path.basename(entry.path) })) : [];
      state.recentFiles = history(saved.recentFiles);
      state.closedTabs = history(saved.closedTabs);
      for (const entry of saved.tabs) {
        if (!entry || !['text', 'epub'].includes(entry.kind)) continue;
        if (entry.kind === 'epub') {
          if (typeof entry.path === 'string') await openEpubFile(entry.path);
          continue;
        }
        const filePath = typeof entry.path === 'string' ? entry.path : null;
        if (filePath && state.tabs.some(t => sameFile(t.path, filePath))) continue;
        const name = filePath ? path.basename(filePath) : (typeof entry.name === 'string' ? entry.name : 'Untitled.md');
        const originalContent = typeof entry.content === 'string' ? entry.content : '';
        const disk = filePath ? await ipcRenderer.invoke('read-file', filePath) : null;
        // Clean files load the current disk version. Drafts retain the exact
        // recovery text and original disk baseline, so saves still detect conflicts.
        const restoreDraft = Boolean(entry.dirty || !filePath || !disk?.ok);
        const tab = createTextTab(name, filePath, restoreDraft ? originalContent : disk.content);
        if (restoreDraft) {
          tab.savedContent = typeof entry.savedContent === 'string' ? entry.savedContent : (disk?.ok ? disk.content : '');
          tab.dirty = Boolean(entry.dirty || (filePath && !disk?.ok) || tab.content !== tab.savedContent);
          tab.diskVersion = entry.diskVersion ?? null;
          tab.identity = entry.identity || null; tab.realPath = entry.realPath || null;
          if (filePath && (!disk?.ok || disk.version !== tab.diskVersion)) {
            tab.external = { exists: Boolean(disk?.ok), version: disk?.version || null };
          }
          if (tab.dirty || tab.content) recoveredCount++;
        } else applyDiskState(tab, disk);
        if (entry.viewState && Number.isFinite(entry.viewState.anchor) && Number.isFinite(entry.viewState.head)) {
          tab.pendingEditorRestore = { ...entry.viewState, focused: false };
          tab.viewState = entry.viewState;
        }
        state.tabs.push(tab);
      }
      renderTabs();
      const selected = state.tabs[Math.min(Math.max(0, Number(saved.activeIndex) || 0), state.tabs.length - 1)];
      if (selected) activateTab(selected.id);
      if (saved.rootDir) await openFolder(saved.rootDir);
      $sidebar.classList.toggle('collapsed', saved.sidebarCollapsed !== false);
      if (/^\d+(\.\d+)?px$/.test(saved.sidebarWidth || '')) $sidebar.style.width = saved.sidebarWidth;
      if (result.recoveredFromBackup) recoveryNotice = 'Recovered from session backup';
      else if (recoveredCount) recoveryNotice = `Recovered ${recoveredCount} ${recoveredCount === 1 ? 'draft' : 'drafts'}`;
    }
    untitledCount = state.tabs.reduce((count, tab) => {
      const match = /^Untitled(?:-(\d+))?\.md$/.exec(tab.name);
      return match ? Math.max(count, Number(match[1] || 1)) : count;
    }, 0);
  } catch (error) { showFileError('Could not restore the previous session', '', error); }
  workspaceInitialized = true;
  const file = await ipcRenderer.invoke('get-argv-file');
  if (file) {
    if (!state.rootDir) await openFolder(path.dirname(file));
    if (!(await openFile(file))) ensureEditableWorkspace();
  } else ensureEditableWorkspace();
  updateFileControls(); renderDocumentNotice(); scheduleSession();
  return true;
}

window.addEventListener('focus', () => { checkExternalChanges().catch(() => {}); });
setInterval(() => {
  if (!document.hidden) checkExternalChanges().catch(() => {});
}, 2000);
window.addEventListener('beforeunload', () => {
  if (workspaceInitialized && !workspaceClosing) {
    // Normal close is already flushed by the close handshake. Reload and
    // renderer navigation need a synchronous last snapshot before teardown.
    ipcRenderer.sendSync('write-session-sync', createSessionSnapshot());
  }
});

// Restore recovery data before processing launch requests.
window.workspaceReady = initializeWorkspace();
ipcRenderer.on('activate-text-workspace', async () => {
  await window.workspaceReady; ensureEditableWorkspace();
});
ipcRenderer.on('open-file-path', async (_event, file) => {
  await window.workspaceReady;
  if (!state.rootDir) await openFolder(path.dirname(file));
  await openFile(file);
});

ipcRenderer.on('window-close-requested', async () => {
  if (windowClosePromptPending || workspaceCommitting) {
    ipcRenderer.send('window-close-response', false); return;
  }
  windowClosePromptPending = true;
  let shouldClose = false;
  try {
    await window.workspaceReady;
    const dirtyTabs = dirtyTextTabs();
    const decision = dirtyTabs.length ? await confirmDiscardChanges(dirtyTabs, 'window') : 'save';
    if (decision === 'cancel') return;
    if (decision === 'save' && (!(await saveAllTabs()) || dirtyTextTabs().length)) return;
    const fingerprint = () => JSON.stringify(state.tabs.map(t => [t.id, t.path, t.content, t.dirty]));
    const before = fingerprint();
    workspaceClosing = true; workspaceCommitting = true; $('#app').inert = true;
    shouldClose = await flushSession({ discardDrafts: decision === 'discard' });
    // Also guard programmatic/in-flight edits that can bypass an inert surface.
    if (fingerprint() !== before) { shouldClose = false; await flushSession(); }
  } finally {
    if (!shouldClose) {
      workspaceClosing = false; workspaceCommitting = false; $('#app').inert = false;
      activeTab()?.editorView?.focus(); scheduleSession();
    }
    ipcRenderer.send('window-close-response', shouldClose);
    windowClosePromptPending = false;
  }
});

document.documentElement.dataset.platform = process.platform;

if (process.platform === 'linux') {
  const tabBar = $('#tab-bar');
  const btnContainer = document.createElement('div');
  btnContainer.id = 'window-controls';
  btnContainer.innerHTML =
    '<button id="btn-win-minimize" title="Minimize">&#x2500;</button>' +
    '<button id="btn-win-maximize" title="Maximize">&#x25A1;</button>' +
    '<button id="btn-win-close" title="Close">&#x2715;</button>';
  tabBar.appendChild(btnContainer);

  $('#btn-win-minimize').addEventListener('click', () => ipcRenderer.send('window-minimize'));
  $('#btn-win-maximize').addEventListener('click', () => ipcRenderer.send('window-maximize'));
  $('#btn-win-close').addEventListener('click', () => ipcRenderer.send('window-close'));

  ipcRenderer.on('window-maximized-changed', (_e, maximized) => {
    $('#btn-win-maximize').innerHTML = maximized ? '&#x29C9;' : '&#x25A1;';
    $('#btn-win-maximize').title = maximized ? 'Restore' : 'Maximize';
  });

  ipcRenderer.invoke('window-is-maximized').then((maximized) => {
    if (maximized) {
      $('#btn-win-maximize').innerHTML = '&#x29C9;';
      $('#btn-win-maximize').title = 'Restore';
    }
  });
}

requestAnimationFrame(() => {
  requestAnimationFrame(() => ipcRenderer.send('renderer-ready'));
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.altKey && !event.shiftKey && !event.isComposing && !event.getModifierState('AltGraph') && event.code === 'KeyS') {
    event.preventDefault(); saveAllTabs(); return;
  }
  if (!event.ctrlKey || event.altKey || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  // An IME or non-Latin layout may report a non-letter key while retaining the
  // physical KeyS/KeyN code. Keep Latin layout shortcuts and use that fallback.
  const key = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase()
    : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : '';
  if (key === 't' && event.shiftKey) {
    event.preventDefault(); reopenClosedTab();
  } else if (key === 'n') {
    event.preventDefault();
    newFile();
  } else if (key === 'o') {
    event.preventDefault();
    runFileCommand('open');
  } else if (key === 's' && event.shiftKey) {
    event.preventDefault();
    saveAsActiveTab();
  } else if (key === 's') {
    event.preventDefault();
    saveActiveTab();
  } else if (key === 'w') {
    event.preventDefault();
    if (state.activeTab) closeTab(state.activeTab);
  } else if (key === 'b') {
    event.preventDefault();
    toggleSidebar();
  } else if (key === 'f' || key === 'h') {
    const tab = activeTab();
    if (tab && tab.kind === 'text' && tab.editorView) {
      event.preventDefault();
      openSearch(tab.editorView);
    }
  }
});

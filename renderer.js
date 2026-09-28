const { ipcRenderer } = require('electron');
const path = require('path');
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
  tabSequence: 0
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

async function confirmDiscardChanges(tabs, scope = 'tab') {
  const dirtyTabs = tabs.filter((tab) => isOpenTab(tab) && tab.kind === 'text' && tab.dirty);
  if (!dirtyTabs.length) return true;
  if (discardPromptInFlight) return false;

  discardPromptInFlight = true;
  try {
    return Boolean(await ipcRenderer.invoke('confirm-discard-changes', {
      scope,
      count: dirtyTabs.length,
      names: dirtyTabs.map((tab) => tab.name)
    }));
  } catch {
    return false;
  } finally {
    discardPromptInFlight = false;
  }
}

// --- File Tree ---

async function openFolder(dirPath) {
  if (!dirPath) return;
  state.rootDir = dirPath;
  $folderName.textContent = path.basename(dirPath);
  $folderName.title = dirPath;
  $fileTree.replaceChildren();
  await renderTree(dirPath, $fileTree, 0);
}

async function renderTree(dirPath, container, depth) {
  const entries = await ipcRenderer.invoke('read-dir', dirPath);
  for (const entry of entries) {
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
    const newPath = path.join(path.dirname(oldPath), newName);
    if (fileKind(oldPath) !== fileKind(newPath)) {
      window.alert('Renaming cannot change a file between text, EPUB, and unsupported formats. Keep the current file type, or use Save As for another text format.');
      onDone(null);
      return;
    }
    const ok = await ipcRenderer.invoke('rename-file', oldPath, newPath);
    onDone(ok ? { newPath, newName } : null);
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
  if (!filePath) return;
  const existing = state.tabs.find((tab) => sameFile(tab.path, filePath));
  if (existing) {
    activateTab(existing.id);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.epub') {
    await openEpubFile(filePath);
    return;
  }

  const content = await ipcRenderer.invoke('read-file', filePath);
  if (content === null) return;

  const tab = createTextTab(path.basename(filePath), filePath, content);
  state.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
}

function createTextTab(name, filePath, content) {
  return {
    kind: 'text',
    id: nextTabId(),
    path: filePath,
    name,
    content,
    savedContent: content,
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
  renderSidebar(tab);
  $statusPath.textContent = tab.path || '';
  updateStatusBar(tab);
  ensureActiveTabVisible();
}

function detachTab(tab) {
  if (tab.kind === 'text' && tab.editorView) tab.editorView.dom.remove();
  if (tab.kind === 'epub' && tab.host) {
    tab.host.classList.add('is-hidden');
    tab.host.setAttribute('aria-hidden', 'true');
  }
}

async function closeTab(id) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return false;

  const tab = state.tabs[index];
  if (tab.kind === 'text' && tab.dirty) {
    if (tab.closePromptPending) return false;
    tab.closePromptPending = true;
    const shouldDiscard = await confirmDiscardChanges([tab]);
    tab.closePromptPending = false;
    if (!shouldDiscard || !isOpenTab(tab)) return false;
  }

  const currentIndex = state.tabs.indexOf(tab);
  if (currentIndex === -1) return false;
  const wasActive = state.activeTab === id;
  tab.closed = true;
  if (tab.kind === 'text' && tab.editorView) {
    destroyEditorView(tab.editorView);
    tab.editorView = null;
  } else if (tab.kind === 'epub') {
    if (tab.epubView) destroyEpubView(tab.epubView);
    tab.epubView = null;
    tab.host.remove();
  }

  state.tabs.splice(currentIndex, 1);
  if (wasActive) state.activeTab = null;
  renderTabs();

  if (wasActive) {
    const next = state.tabs[Math.min(currentIndex, state.tabs.length - 1)];
    if (next) activateTab(next.id);
    else renderEmptyState();
  } else {
    ensureActiveTabVisible();
  }
  return true;
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
      },
      fileExt: path.extname(tab.name).toLowerCase()
    });
    restoreTextEditorState(tab);
  } else {
    $content.appendChild(tab.editorView.dom);
    tab.editorView.requestMeasure();
  }
}

function renderEmptyState() {
  state.activeTab = null;
  $content.innerHTML = '<div id="welcome"><h2>Moth</h2><p>Open a folder, document, or EPUB to get started.</p></div>';
  $statusPath.textContent = '';
  $statusStats.textContent = '';
  renderSidebar(null);
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

async function saveActiveTab() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'text') return;
  if (tab.path && !tab.dirty && tab.savedContent === tab.content) return;

  let targetPath = tab.path;
  if (!targetPath) {
    const filePath = await ipcRenderer.invoke('save-file-dialog', tab.name);
    if (!filePath) return;
    if (fileKind(filePath) === 'epub') {
      window.alert('Text documents cannot be saved over an EPUB book. Choose a text, Markdown, JSON, or JSONL filename.');
      return;
    }
    targetPath = filePath;
  }

  const contentToSave = tab.content;
  const success = await ipcRenderer.invoke('write-file', targetPath, contentToSave);
  if (!success || !isOpenTab(tab)) return;

  tab.savedContent = contentToSave;
  tab.dirty = tab.content !== contentToSave;
  if (!tab.path) updateTabPath(tab, targetPath, path.basename(targetPath));
  else renderTabs();
  if (tab.id === state.activeTab) $statusPath.textContent = tab.path;
}

async function saveAsActiveTab() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'text') return;
  const filePath = await ipcRenderer.invoke('save-file-dialog', tab.name);
  if (!filePath) return;
  if (fileKind(filePath) === 'epub') {
    window.alert('Text documents cannot be saved over an EPUB book. Choose a text, Markdown, JSON, or JSONL filename.');
    return;
  }
  const contentToSave = tab.content;
  const success = await ipcRenderer.invoke('write-file', filePath, contentToSave);
  if (!success || !isOpenTab(tab)) return;

  tab.savedContent = contentToSave;
  tab.dirty = tab.content !== contentToSave;
  updateTabPath(tab, filePath, path.basename(filePath));
}

// --- EPUB sidebar and progress ---

function renderSidebar(tab) {
  const isEpub = tab && tab.kind === 'epub';
  $fileSidebar.classList.toggle('hidden', isEpub);
  $epubSidebar.classList.toggle('hidden', !isEpub);
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

$('#btn-open-folder').addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke('open-folder');
  if (dir) openFolder(dir);
});

$('#btn-open-file').addEventListener('click', async () => {
  const file = await ipcRenderer.invoke('open-file-dialog');
  if (file) {
    if (!state.rootDir) openFolder(path.dirname(file));
    openFile(file);
  }
});

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

function toggleSidebar() {
  prepareActiveEpubResize();
  $sidebar.classList.toggle('collapsed');
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
});

$tabs.addEventListener('wheel', (event) => {
  if ($tabs.scrollWidth <= $tabs.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  event.preventDefault();
  $tabs.scrollLeft += delta;
}, { passive: false });

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

// Open initial and subsequent files.
(async () => {
  const file = await ipcRenderer.invoke('get-argv-file');
  if (file) {
    await openFolder(path.dirname(file));
    openFile(file);
  }
})();

ipcRenderer.on('open-file-path', (_event, file) => {
  if (!state.rootDir) openFolder(path.dirname(file));
  openFile(file);
});

ipcRenderer.on('window-close-requested', async () => {
  if (windowClosePromptPending) return;
  windowClosePromptPending = true;
  let shouldClose = false;
  try {
    const dirtyTabs = dirtyTextTabs();
    shouldClose = dirtyTabs.length
      ? await confirmDiscardChanges(dirtyTabs, 'window')
      : true;
  } finally {
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
  if (!event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (key === 'n') {
    event.preventDefault();
    newFile();
  } else if (key === 'o') {
    event.preventDefault();
    $('#btn-open-file').click();
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

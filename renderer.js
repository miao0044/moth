const { ipcRenderer } = require('electron');
const path = require('path');
const { createEditorView, destroyEditorView, openSearch } = require('./dist/editor.bundle');

const state = {
  tabs: [],
  activeTab: null,
  rootDir: null
};

const $ = (s) => document.querySelector(s);
const $tabs = $('#tabs');
const $content = $('#content');
const $fileTree = $('#file-tree');
const $folderName = $('#folder-name');
const $statusPath = $('#status-path');
const $statusStats = $('#status-stats');

// --- File Tree ---

async function openFolder(dirPath) {
  if (!dirPath) return;
  state.rootDir = dirPath;
  $folderName.textContent = path.basename(dirPath);
  $fileTree.innerHTML = '';
  await renderTree(dirPath, $fileTree, 0);
}

async function renderTree(dirPath, container, depth) {
  const entries = await ipcRenderer.invoke('read-dir', dirPath);
  for (const entry of entries) {
    const item = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'tree-item' + (entry.isDir ? ' dir' : '');
    row.style.paddingLeft = (10 + depth * 16) + 'px';
    row.dataset.path = entry.path;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = entry.isDir ? '▸' : fileIcon(entry.ext);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;

    row.appendChild(icon);
    row.appendChild(name);
    item.appendChild(row);

    if (entry.isDir) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      item.appendChild(children);
      let loaded = false;

      row.addEventListener('click', async () => {
        const isOpen = children.classList.contains('open');
        children.classList.toggle('open');
        icon.textContent = isOpen ? '▸' : '▾';
        if (!loaded) {
          loaded = true;
          await renderTree(entry.path, children, depth + 1);
        }
      });
    } else if (['.md', '.markdown', '.txt'].includes(entry.ext)) {
      row.addEventListener('click', () => openFile(entry.path));
    } else {
      row.style.color = '#555';
    }

    if (!entry.isDir) {
      row.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const nameSpan = row.querySelector('.name');
        if (!nameSpan) return;
        const input = await renameFile(entry.path, entry.name, (result) => {
          if (result) {
            const tab = state.tabs.find(t => t.path === entry.path);
            if (tab) {
              tab.path = result.newPath;
              tab.name = result.newName;
              renderTabs();
              if (tab.id === state.activeTab) $statusPath.textContent = result.newPath;
            }
            entry.path = result.newPath;
            entry.name = result.newName;
            entry.ext = path.extname(result.newName).toLowerCase();
            row.dataset.path = result.newPath;
            const icon = row.querySelector('.icon');
            if (icon) icon.textContent = fileIcon(entry.ext);
          }
          const span = document.createElement('span');
          span.className = 'name';
          span.textContent = entry.name;
          const existing = row.querySelector('.rename-input');
          if (existing) existing.replaceWith(span);
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

  const dotIdx = oldName.lastIndexOf('.');
  requestAnimationFrame(() => {
    input.focus();
    if (dotIdx > 0) input.setSelectionRange(0, dotIdx);
    else input.select();
  });

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) { onDone(null); return; }
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    const ok = await ipcRenderer.invoke('rename-file', oldPath, newPath);
    if (ok) onDone({ newPath, newName });
    else onDone(null);
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; onDone(null); }
  });
  input.addEventListener('blur', () => commit());
  return input;
}

function fileIcon(ext) {
  if (ext === '.md' || ext === '.markdown') return '◇';
  if (ext === '.txt') return '◇';
  if (ext === '.pdf') return '▪';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext)) return '▪';
  return '·';
}

// --- Tabs ---

async function openFile(filePath) {
  const existing = state.tabs.find(t => t.path === filePath);
  if (existing) {
    activateTab(existing.id);
    return;
  }

  const content = await ipcRenderer.invoke('read-file', filePath);
  if (content === null) return;

  const tab = {
    id: Date.now().toString(),
    path: filePath,
    name: path.basename(filePath),
    content,
    savedContent: content,
    dirty: false,
    editorView: null
  };
  state.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
}

function activateTab(id) {
  // Detach previous editor
  const prevTab = state.tabs.find(t => t.id === state.activeTab);
  if (prevTab && prevTab.editorView) {
    prevTab.editorView.dom.remove();
  }

  state.activeTab = id;
  const tab = state.tabs.find(t => t.id === id);

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  document.querySelectorAll('.tree-item').forEach(t => {
    t.classList.toggle('active', tab && t.dataset.path === tab.path);
  });

  if (tab) {
    renderContent(tab);
    $statusPath.textContent = tab.path;
    updateStatusBar(tab);
  }
}

function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;

  const tab = state.tabs[idx];
  if (tab.editorView) {
    destroyEditorView(tab.editorView);
    tab.editorView = null;
  }
  state.tabs.splice(idx, 1);

  if (state.activeTab === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    state.activeTab = next ? next.id : null;
    if (next) activateTab(next.id);
    else {
      $content.innerHTML = '<div id="welcome"><h2>Moth</h2><p>Open a folder or file to get started.</p></div>';
      $statusPath.textContent = '';
      $statusStats.textContent = '';
    }
  }
  renderTabs();
}

function renderTabs() {
  $tabs.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeTab ? ' active' : '');
    el.dataset.id = tab.id;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = (tab.dirty ? '● ' : '') + tab.name;

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });

    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener('click', () => activateTab(tab.id));

    el.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (!tab.path) return;
      const input = await renameFile(tab.path, tab.name, (result) => {
        if (result) {
          const treeItem = document.querySelector(`.tree-item[data-path="${CSS.escape(tab.path)}"]`);
          tab.path = result.newPath;
          tab.name = result.newName;
          if (tab.id === state.activeTab) $statusPath.textContent = result.newPath;
          if (treeItem) {
            treeItem.dataset.path = result.newPath;
            const nameSpan = treeItem.querySelector('.name');
            if (nameSpan) nameSpan.textContent = result.newName;
            const icon = treeItem.querySelector('.icon');
            if (icon) icon.textContent = fileIcon(path.extname(result.newName).toLowerCase());
          }
        }
        renderTabs();
      });
      title.textContent = '';
      title.appendChild(input);
    });

    $tabs.appendChild(el);
  }
}

// --- Editor ---

function renderContent(tab) {
  $content.innerHTML = '';

  if (!tab.editorView) {
    tab.editorView = createEditorView($content, tab.content, {
      onChange: (newContent) => {
        tab.content = newContent;
        tab.dirty = (newContent !== tab.savedContent);
        renderTabs();
        updateStatusBar(tab);
      }
    });
  } else {
    $content.appendChild(tab.editorView.dom);
    tab.editorView.requestMeasure();
  }
}

function updateStatusBar(tab) {
  const words = tab.content.trim().split(/\s+/).filter(Boolean).length;
  const chars = tab.content.length;
  $statusStats.textContent = `${words} words · ${chars} characters`;
}

async function saveActiveTab() {
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (!tab) return;
  if (!tab.path) {
    const filePath = await ipcRenderer.invoke('save-file-dialog', tab.name);
    if (!filePath) return;
    tab.path = filePath;
    tab.name = path.basename(filePath);
  }
  if (!tab.dirty && tab.savedContent === tab.content) return;
  const success = await ipcRenderer.invoke('write-file', tab.path, tab.content);
  if (success) {
    tab.dirty = false;
    tab.savedContent = tab.content;
    renderTabs();
    $statusPath.textContent = tab.path;
  }
}

// --- New File ---

let untitledCount = 0;

function newFile() {
  untitledCount++;
  const name = untitledCount === 1 ? 'Untitled.md' : `Untitled-${untitledCount}.md`;
  const tab = {
    id: Date.now().toString(),
    path: null,
    name,
    content: '',
    savedContent: '',
    dirty: false,
    editorView: null
  };
  state.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
}

// --- Events ---

$('#btn-new-file').addEventListener('click', () => newFile());

$('#btn-search').addEventListener('click', () => {
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (tab && tab.editorView) openSearch(tab.editorView);
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

// Sidebar toggle
const sidebar = $('#sidebar');
$('#btn-toggle-sidebar').addEventListener('click', () => sidebar.classList.toggle('collapsed'));

// Sidebar resize
const resizer = $('#sidebar-resize');
let isResizing = false;
resizer.addEventListener('mousedown', () => { isResizing = true; document.body.style.cursor = 'col-resize'; });
document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const w = Math.max(160, Math.min(500, e.clientX));
  sidebar.style.width = w + 'px';
});
document.addEventListener('mouseup', () => { isResizing = false; document.body.style.cursor = ''; });

// Open file from command-line args
(async () => {
  const file = await ipcRenderer.invoke('get-argv-file');
  if (file) {
    await openFolder(path.dirname(file));
    openFile(file);
  }
})();

// Handle files opened while app is already running
ipcRenderer.on('open-file-path', (_e, file) => {
  if (!state.rootDir) openFolder(path.dirname(file));
  openFile(file);
});

// --- Settings ---

const defaults = { font: "serif", fontSize: 16, padding: 50, spacing: 100 };
const settings = { ...defaults, ...JSON.parse(localStorage.getItem('md-settings') || '{}') };

function applySettings() {
  document.documentElement.style.setProperty('--md-font', settings.font);
  document.documentElement.style.setProperty('--md-font-size', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--content-padding', settings.padding + 'px');
  document.documentElement.style.setProperty('--md-spacing', settings.spacing / 100);
  $('#setting-font').value = settings.font;
  $('#setting-font-size').value = settings.fontSize;
  $('#setting-padding').value = settings.padding;
  $('#setting-spacing').value = settings.spacing;
  $('#font-size-val').textContent = settings.fontSize + 'px';
  $('#padding-val').textContent = settings.padding + 'px';
  $('#spacing-val').textContent = settings.spacing + '%';
  localStorage.setItem('md-settings', JSON.stringify(settings));

  // Trigger CM6 re-measure when settings change
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (tab && tab.editorView) tab.editorView.requestMeasure();
}

$('#btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#settings-panel').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const panel = $('#settings-panel');
  if (panel.classList.contains('open') && !panel.contains(e.target)) panel.classList.remove('open');
});

$('#setting-font').addEventListener('change', (e) => { settings.font = e.target.value; applySettings(); });
$('#setting-font-size').addEventListener('input', (e) => { settings.fontSize = +e.target.value; applySettings(); });
$('#setting-padding').addEventListener('input', (e) => { settings.padding = +e.target.value; applySettings(); });
$('#setting-spacing').addEventListener('input', (e) => { settings.spacing = +e.target.value; applySettings(); });

applySettings();

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    ipcRenderer.send('renderer-ready');
  });
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    newFile();
  }
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    $('#btn-open-file').click();
  }
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    saveActiveTab();
  }
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (state.activeTab) closeTab(state.activeTab);
  }
  if (e.ctrlKey && e.key === 'b') {
    e.preventDefault();
    sidebar.classList.toggle('collapsed');
  }
});

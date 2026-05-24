const { ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');
const path = require('path');

marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
  breaks: true
});

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
    container.appendChild(item);
  }
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
    content
  };
  state.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
}

function activateTab(id) {
  state.activeTab = id;
  const tab = state.tabs.find(t => t.id === id);

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  document.querySelectorAll('.tree-item').forEach(t => {
    t.classList.toggle('active', tab && t.dataset.path === tab.path);
  });

  if (tab) {
    renderContent(tab);
    $statusPath.textContent = tab.path;
    const words = tab.content.trim().split(/\s+/).filter(Boolean).length;
    const chars = tab.content.length;
    $statusStats.textContent = `${words} words · ${chars} characters`;
  }
}

function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
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
    title.textContent = tab.name;

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });

    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener('click', () => activateTab(tab.id));
    $tabs.appendChild(el);
  }
}

// --- Render Markdown ---

function renderContent(tab) {
  const ext = path.extname(tab.path).toLowerCase();
  if (ext === '.md' || ext === '.markdown') {
    $content.innerHTML = `<div class="markdown-body">${marked.parse(tab.content)}</div>`;
  } else {
    $content.innerHTML = `<div class="markdown-body"><pre><code>${escapeHtml(tab.content)}</code></pre></div>`;
  }
  $content.scrollTop = 0;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// --- Events ---

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

const defaults = { font: "serif", fontSize: 16, padding: 50 };
const settings = { ...defaults, ...JSON.parse(localStorage.getItem('md-settings') || '{}') };

function applySettings() {
  document.documentElement.style.setProperty('--md-font', settings.font);
  document.documentElement.style.setProperty('--md-font-size', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--content-padding', settings.padding + 'px');
  $('#setting-font').value = settings.font;
  $('#setting-font-size').value = settings.fontSize;
  $('#setting-padding').value = settings.padding;
  $('#font-size-val').textContent = settings.fontSize + 'px';
  $('#padding-val').textContent = settings.padding + 'px';
  localStorage.setItem('md-settings', JSON.stringify(settings));
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

applySettings();

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    $('#btn-open-file').click();
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

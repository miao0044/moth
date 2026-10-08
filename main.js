const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fileStore = require('./lib/file-store.cjs');
const { createSessionStore } = require('./lib/session-store.cjs');
let sessionStore;
const getSessionStore = () => sessionStore ||= createSessionStore(app.getPath('userData'));

nativeTheme.themeSource = 'dark';
app.disableHardwareAcceleration();

const isLinux = process.platform === 'linux';

function findFileArg(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.find(a => {
    if (!a || a.startsWith('-')) return false;
    try { return fs.statSync(a).isFile(); } catch (error) { return error.code === 'ENOENT'; }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow;
  let pendingFile = findFileArg(process.argv);

  app.on('second-instance', (_e, argv) => {
    const file = findFileArg(argv);
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (file) pendingFile = file;
      createWindow();
      return;
    }
    if (file) {
      mainWindow.webContents.send('open-file-path', file);
    } else {
      mainWindow.webContents.send('activate-text-workspace');
    }
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  function createWindow() {
    const winOptions = {
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      show: false,
      backgroundColor: '#262626',
      titleBarStyle: 'hidden',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    };
    if (isLinux) {
      winOptions.frame = false;
    } else {
      winOptions.titleBarOverlay = {
        color: '#1e1e1e',
        symbolColor: '#cccccc',
        height: 36
      };
    }
    mainWindow = new BrowserWindow(winOptions);
    const win = mainWindow;
    let rendererReadyForClose = false;
    let closeRequestPending = false;
    let closeApproved = false;

    const handleWindowCloseResponse = (event, shouldClose) => {
      if (event.sender !== win.webContents || !closeRequestPending) return;
      closeRequestPending = false;
      if (!shouldClose || win.isDestroyed()) return;
      closeApproved = true;
      win.close();
    };
    ipcMain.on('window-close-response', handleWindowCloseResponse);

    win.on('close', (event) => {
      if (closeApproved || !rendererReadyForClose || win.webContents.isDestroyed()) return;
      event.preventDefault();
      if (closeRequestPending) return;
      closeRequestPending = true;
      win.webContents.send('window-close-requested');
    });
    // renderer-ready relies on requestAnimationFrame, which may never fire in a
    // hidden window (no compositor frames) — without this fallback the window
    // stays invisible forever and the process lingers holding the instance lock
    const showFallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 1500);
    ipcMain.once('renderer-ready', (event) => {
      if (event.sender !== win.webContents) return;
      rendererReadyForClose = true;
      clearTimeout(showFallback);
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    });
    win.on('closed', () => {
      ipcMain.removeListener('window-close-response', handleWindowCloseResponse);
      if (mainWindow === win) mainWindow = null;
    });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.setMenuBarVisibility(false);

    if (isLinux) {
      win.on('maximize', () => {
        if (!win.isDestroyed()) win.webContents.send('window-maximized-changed', true);
      });
      win.on('unmaximize', () => {
        if (!win.isDestroyed()) win.webContents.send('window-maximized-changed', false);
      });
    }
  }

  ipcMain.handle('get-argv-file', () => {
    const file = pendingFile;
    pendingFile = null;
    return file || null;
  });

  ipcMain.handle('open-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [
        { name: 'Supported Files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'epub'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'JSON', extensions: ['json', 'jsonl'] },
        { name: 'EPUB', extensions: ['epub'] },
      ],
      properties: ['openFile']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('save-file-dialog', async (_, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'JSON', extensions: ['json', 'jsonl'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  // App-owned confirmations use the same Lexend typography as the editor shell.
  ipcMain.handle('confirm-discard-changes', (_event, details = {}) => {
    const names = Array.isArray(details.names) ? details.names.slice(0, 10) : [];
    const multiple = details.scope === 'window';
    return { prompt: {
      title: 'Unsaved changes',
      message: multiple ? 'Save before closing?' : 'Save your changes?',
      detail: names.join('\n'),
      choices: [
        { value: 'cancel', label: 'Cancel', icon: 'close' },
        { value: 'discard', label: 'Discard', icon: 'clear' },
        { value: 'save', label: multiple ? 'Save All' : 'Save', icon: 'save' }
      ], defaultValue: 'save', cancelValue: 'cancel'
    } };
  });
  ipcMain.handle('confirm-file-conflict', (_event, details = {}) => ({ prompt: {
    title: 'File changed on disk', message: 'Keep both versions or replace the disk copy?', detail: details.path || '',
    choices: [
      { value: 'cancel', label: 'Cancel', icon: 'close' },
      { value: 'save-as', label: 'Save As', icon: 'save-as' },
      ...(details.allowReload === false ? [] : [{ value: 'reload', label: 'Reload', icon: 'reload' }]),
      { value: 'overwrite', label: 'Overwrite', icon: 'save' }
    ], defaultValue: 'cancel', cancelValue: 'cancel'
  } }));
  ipcMain.handle('confirm-reload', (_event, filePath) => ({ prompt: {
    title: 'Reload file', message: 'Discard your edits and reload?', detail: filePath || '',
    choices: [{ value: false, label: 'Cancel', icon: 'close' }, { value: true, label: 'Reload', icon: 'reload' }],
    defaultValue: false, cancelValue: false
  } }));
  ipcMain.handle('confirm-overwrite', (_event, filePath) => ({ prompt: {
    title: 'Replace file', message: 'Replace the existing file?', detail: filePath || '',
    choices: [{ value: false, label: 'Cancel', icon: 'close' }, { value: true, label: 'Replace', icon: 'save' }],
    defaultValue: false, cancelValue: false
  } }));

  ipcMain.handle('rename-file', (_, oldPath, newPath, options) => fileStore.renameFile(oldPath, newPath, options));
  ipcMain.handle('file-status', (_, filePath) => fileStore.inspectFile(filePath));
  ipcMain.handle('read-session', () => getSessionStore().read());
  ipcMain.handle('write-session', (_, snapshot, options) => getSessionStore().write(snapshot, options));
  ipcMain.on('write-session-sync', (event, snapshot) => {
    event.returnValue = getSessionStore().write(snapshot);
  });

  ipcMain.handle('read-dir', (_, dirPath) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const children = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(dirPath, e.name),
          isDir: e.isDirectory(),
          ext: path.extname(e.name).toLowerCase()
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { ok: true, entries: children };
    } catch (error) { return { ok: false, code: error.code, message: error.message }; }
  });

  ipcMain.handle('read-file', (_, filePath) => fileStore.readText(filePath));

  ipcMain.handle('read-epub', async (_, filePath) => {
    try {
      const [data, stat] = await Promise.all([
        fs.promises.readFile(filePath),
        fs.promises.stat(filePath)
      ]);
      return {
        ok: true,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'READ_FAILED' };
    }
  });

  ipcMain.handle('write-file', (_, filePath, content, options) => fileStore.writeText(filePath, content, options));

  if (isLinux) {
    ipcMain.on('window-minimize', (event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
    });
    ipcMain.on('window-maximize', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      win.isMaximized() ? win.unmaximize() : win.maximize();
    });
    ipcMain.on('window-close', (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    ipcMain.handle('window-is-maximized', (event) => {
      return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
    });
  }

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.exit(0));
}

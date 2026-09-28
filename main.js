const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

nativeTheme.themeSource = 'dark';
app.disableHardwareAcceleration();

const isLinux = process.platform === 'linux';

function findFileArg(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.find(a => {
    if (!a || a.startsWith('-')) return false;
    try { return fs.statSync(a).isFile(); } catch { return false; }
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
    mainWindow.loadFile('index.html');
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

  ipcMain.handle('confirm-discard-changes', async (event, details = {}) => {
    const names = Array.isArray(details.names)
      ? details.names.filter((name) => typeof name === 'string' && name.trim()).slice(0, 10)
      : [];
    const isWindowClose = details.scope === 'window';
    const count = Math.max(names.length, Number.isFinite(details.count) ? Math.trunc(details.count) : 0);
    const message = isWindowClose
      ? `Discard unsaved changes in ${count || 'the open'} ${count === 1 ? 'file' : 'files'}?`
      : `Discard unsaved changes in "${names[0] || 'this file'}"?`;
    const detail = isWindowClose && names.length
      ? names.map((name) => `• ${name}`).join('\n')
      : 'Changes that have not been saved will be lost.';
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      type: 'warning',
      title: 'Unsaved changes',
      message,
      detail,
      buttons: ['Keep Editing', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };
    const result = owner && !owner.isDestroyed()
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  });

  ipcMain.handle('rename-file', (_, oldPath, newPath) => {
    try { fs.renameSync(oldPath, newPath); return true; }
    catch { return false; }
  });

  ipcMain.handle('read-dir', (_, dirPath) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries
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
    } catch { return []; }
  });

  ipcMain.handle('read-file', (_, filePath) => {
    try { return fs.readFileSync(filePath, 'utf-8'); }
    catch { return null; }
  });

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

  ipcMain.handle('write-file', (_, filePath, content) => {
    try { fs.writeFileSync(filePath, content, 'utf-8'); return true; }
    catch { return false; }
  });

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

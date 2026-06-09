const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

nativeTheme.themeSource = 'dark';
app.disableHardwareAcceleration();

const FILE_EXTS = ['.md', '.markdown', '.txt'];

function findFileArg(argv) {
  return argv.find(a => FILE_EXTS.includes(path.extname(a).toLowerCase()) && fs.existsSync(a));
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
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      show: false,
      backgroundColor: '#262626',
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#1e1e1e',
        symbolColor: '#cccccc',
        height: 36
      },
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    const win = mainWindow;
    // renderer-ready relies on requestAnimationFrame, which may never fire in a
    // hidden window (no compositor frames) — without this fallback the window
    // stays invisible forever and the process lingers holding the instance lock
    const showFallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 1500);
    ipcMain.once('renderer-ready', () => {
      clearTimeout(showFallback);
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    });
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);
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
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
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
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled) return null;
    return result.filePath;
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

  ipcMain.handle('write-file', (_, filePath, content) => {
    try { fs.writeFileSync(filePath, content, 'utf-8'); return true; }
    catch { return false; }
  });

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.exit(0));
}

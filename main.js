const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

nativeTheme.themeSource = 'dark';

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
    if (file && mainWindow) {
      mainWindow.webContents.send('open-file-path', file);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      backgroundColor: '#262626',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
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
  app.on('window-all-closed', () => app.quit());
}

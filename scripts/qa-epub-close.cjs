const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const esbuild = require('esbuild');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(app.getPath('temp'), 'moth-epub-close-qa'));

async function run() {
  const temporary = fs.mkdtempSync(path.join(app.getPath('temp'), 'moth-epub-close-'));
  let window;
  try {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">rapid-close</dc:identifier><dc:title>Rapid close</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
    zip.file('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>');
    zip.file('chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter</h1><p>Rapid open and close regression.</p></body></html>');
    const fixture = path.join(temporary, 'valid.epub');
    fs.writeFileSync(fixture, await zip.generateAsync({ type: 'nodebuffer' }));

    // Use the real library as a shared dependency so the test can observe that
    // every captured Book is eventually destroyed, including invalid opens.
    const library = require.resolve('epubjs');
    const bundle = path.join(temporary, 'reader.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/epub/index.js')],
      bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
      loader: { '.woff2': 'dataurl' },
      plugins: [{ name: 'shared-epubjs', setup(build) {
        build.onResolve({ filter: /^epubjs$/ }, () => ({ path: library, external: true }));
      } }]
    });
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message); });
    await window.loadURL('data:text/html,<html><body></body></html>');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { createEpubView } = require(${JSON.stringify(bundle)});
      const { Book } = require(${JSON.stringify(library)});
      const originalDestroy = Book.prototype.destroy;
      const destroyed = [];
      const errors = [];
      const onRejection = event => { errors.push(String(event.reason?.stack || event.reason)); event.preventDefault(); };
      const onNodeRejection = error => errors.push(String(error?.stack || error));
      window.addEventListener('unhandledrejection', onRejection);
      process.on('unhandledRejection', onNodeRejection);
      Book.prototype.destroy = function () { destroyed.push(this); return originalDestroy.call(this); };
      try {
        const bytes = require('fs').readFileSync(${JSON.stringify(fixture)});
        const expected = 13;
        for (let i = 0; i < 12; i++) {
          const parent = document.createElement('div');
          document.body.appendChild(parent);
          const view = createEpubView(parent, i < 10 ? bytes : new Uint8Array([1, 2, 3]));
          view.destroy();
          view.destroy();
          if (view.state !== 'destroyed' || view.dom.isConnected || parent.childElementCount) throw new Error('Close did not remove the surface immediately');
          const code = await view.ready.then(() => 'RESOLVED', error => error.code);
          if (code !== 'EPUB_DESTROYED') throw new Error('Close did not reject ready immediately: ' + code);
          parent.remove();
        }
        const malformed = createEpubView(document.body, new Uint8Array([9, 8, 7]));
        const errorCode = await malformed.ready.then(() => 'RESOLVED', error => error.code);
        if (errorCode !== 'EPUB_INVALID') throw new Error('Invalid archive was not rejected: ' + errorCode);
        malformed.destroy();
        const start = Date.now();
        while (destroyed.length < expected && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 25));
        await new Promise(resolve => setTimeout(resolve, 300));
        if (destroyed.length !== expected) throw new Error('Book cleanup did not finish exactly once: ' + destroyed.length);
        if (destroyed.some(book => book.loading !== undefined)) throw new Error('Book cleanup was incomplete');
        if (errors.length) throw new Error('Unhandled EPUB failure: ' + errors.join(' | '));
        return { validImmediateCloses: 10, invalidImmediateCloses: 2, malformedOpen: true, immediateSurfaceRemoval: true, immediateReadyRejection: true, booksDestroyedExactlyOnce: destroyed.length, unhandledRejections: errors.length };
      } finally {
        Book.prototype.destroy = originalDestroy;
        window.removeEventListener('unhandledrejection', onRejection);
        process.removeListener('unhandledRejection', onNodeRejection);
      }
    })()`, true);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

app.whenReady().then(run).then(() => app.exit(0), error => { console.error(error); app.exit(1); });

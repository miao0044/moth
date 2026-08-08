const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(app.getPath('temp'), 'moth-electron-qa'));

async function makeEpub(fixedLayout = false) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
    <package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">moth-qa</dc:identifier><dc:title>Moth Reader QA</dc:title><dc:language>en</dc:language>
        <meta property="dcterms:modified">2026-08-08T00:00:00Z</meta>
        ${fixedLayout ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="one" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
        <item id="two" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="one"/><itemref idref="two"/></spine>
    </package>`);
  zip.file('OEBPS/nav.xhtml', `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter-1.xhtml">First light</a></li><li><a href="chapter-2.xhtml">Second light</a></li></ol></nav></body></html>`);
  zip.file('OEBPS/chapter-1.xhtml', `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>First light</title><style>body { font-family: fantasy !important; }</style></head><body><h1>First light</h1><p id="publisher-font" style="font-family: 'Courier New' !important">Publisher typography must not survive.</p><pre id="code-font">const moth = true;</pre><p>${'A quiet paragraph for continuous reading. '.repeat(80)}</p></body></html>`);
  zip.file('OEBPS/chapter-2.xhtml', `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second light</title></head><body><h1>Second light</h1><p>The second chapter confirms navigation.</p></body></html>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function registerIpc(epubBuffer, fixedEpubBuffer) {
  const writes = [];
  let pendingWrite = null;

  ipcMain.handle('get-argv-file', () => null);
  ipcMain.handle('read-dir', () => []);
  ipcMain.handle('read-file', (_event, filePath) => path.extname(filePath).toLowerCase() === '.jsonl'
    ? '{"first":1}\n{"second":[true,false]}'
    : '# QA\n');
  ipcMain.handle('read-epub', (_event, filePath) => {
    const data = filePath.includes('fixed-layout') ? fixedEpubBuffer : epubBuffer;
    return {
    ok: true,
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    size: data.byteLength,
    mtimeMs: 1
    };
  });
  ipcMain.handle('open-folder', () => null);
  ipcMain.handle('open-file-dialog', () => null);
  ipcMain.handle('save-file-dialog', () => null);
  ipcMain.handle('rename-file', () => false);
  ipcMain.handle('write-file', (_event, filePath, content) => {
    const record = { filePath, content, completed: false };
    writes.push(record);
    if (!filePath.includes('save-race')) {
      record.completed = true;
      return true;
    }

    return new Promise((resolve) => {
      pendingWrite = { record, resolve };
    });
  });
  ipcMain.handle('qa-write-state', () => ({
    pending: Boolean(pendingWrite),
    lastWrite: writes.length ? { ...writes[writes.length - 1] } : null
  }));
  ipcMain.handle('qa-release-write', () => {
    if (!pendingWrite) return false;
    const write = pendingWrite;
    pendingWrite = null;
    write.record.completed = true;
    write.resolve(true);
    return true;
  });
}

async function waitForRenderer(window, expression, predicate, label, timeout = 15000) {
  const started = Date.now();
  let lastValue = null;
  let lastError = null;

  while (Date.now() - started <= timeout) {
    try {
      lastValue = await window.webContents.executeJavaScript(expression, true);
      lastError = null;
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const diagnostics = lastError
    ? lastError.message
    : JSON.stringify(lastValue);
  throw new Error(`QA wait timed out (${label}): ${diagnostics}`);
}

async function run() {
  const [epub, fixedEpub] = await Promise.all([makeEpub(), makeEpub(true)]);
  registerIpc(epub, fixedEpub);
  const fixturePath = path.join(app.getPath('temp'), 'moth-reader-qa.epub');
  fs.writeFileSync(fixturePath, epub);

  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: true,
    backgroundColor: '#262626',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  await window.loadFile(path.join(__dirname, '..', 'index.html'));

  const report = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (test, timeout = 10000) => {
      const started = Date.now();
      while (!(await test())) {
        if (Date.now() - started > timeout) throw new Error('QA wait timed out');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const nextPaint = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const fontSelect = document.querySelector('#setting-font');
    fontSelect.value = 'Lexend, sans-serif';
    fontSelect.dispatchEvent(new Event('change', { bubbles: true }));
    Object.keys(epubPositions).forEach((key) => delete epubPositions[key]);
    localStorage.removeItem(EPUB_PROGRESS_KEY);
    await document.fonts.ready;

    newFile();
    await nextPaint();
    const singleTabWidth = document.querySelector('#tabs .tab').getBoundingClientRect().width;

    newFile();
    await nextPaint();
    const naturalTabElements = [...document.querySelectorAll('#tabs .tab')];
    const naturalTabWidths = naturalTabElements.map((tab) => tab.getBoundingClientRect().width);
    const smallTabLayout = {
      singleTabWidth,
      widths: naturalTabWidths,
      firstWidthStable: Math.abs(naturalTabWidths[0] - singleTabWidth) <= 1,
      noOverflow: document.querySelector('#tabs').scrollWidth <= document.querySelector('#tabs').clientWidth,
      closeOpacities: naturalTabElements.map((tab) => getComputedStyle(tab.querySelector('.tab-close')).opacity)
    };

    for (let index = 0; index < 26; index += 1) newFile();
    await nextPaint();

    await openFile('C:\\\\QA\\\\save-race.md');
    const saveRaceTab = state.tabs.find((tab) => tab.name === 'save-race.md');
    await waitFor(() => Boolean(saveRaceTab?.editorView));
    const savedSnapshot = '# Snapshot actually written\\n';
    saveRaceTab.editorView.dispatch({
      changes: { from: 0, to: saveRaceTab.editorView.state.doc.length, insert: savedSnapshot }
    });
    await waitFor(() => saveRaceTab.content === savedSnapshot && saveRaceTab.dirty);
    const savePromise = saveActiveTab();
    await waitFor(async () => (await ipcRenderer.invoke('qa-write-state')).pending);

    const editedWhileSaving = '# Snapshot actually written\\nStill editing while the write is pending.\\n';
    saveRaceTab.editorView.dispatch({
      changes: { from: 0, to: saveRaceTab.editorView.state.doc.length, insert: editedWhileSaving }
    });
    await waitFor(() => saveRaceTab.content === editedWhileSaving);
    const pendingWrite = await ipcRenderer.invoke('qa-write-state');
    await ipcRenderer.invoke('qa-release-write');
    await savePromise;
    const completedWrite = await ipcRenderer.invoke('qa-write-state');
    const saveRace = {
      writtenContent: completedWrite.lastWrite?.content || pendingWrite.lastWrite?.content || null,
      savedContent: saveRaceTab.savedContent,
      currentContent: saveRaceTab.content,
      dirty: saveRaceTab.dirty,
      completed: Boolean(completedWrite.lastWrite?.completed)
    };

    newFile();
    const dirtyCloseTab = activeTab();
    dirtyCloseTab.editorView.dispatch({
      changes: { from: 0, to: 0, insert: 'Unsaved close regression' }
    });
    await waitFor(() => dirtyCloseTab.dirty);
    const originalConfirmDiscardChanges = confirmDiscardChanges;
    let discardPromptCalls = 0;
    let cancelledCloseResult = null;
    let confirmedCloseResult = null;
    let retainedAfterCancel = false;
    let removedAfterConfirm = false;
    try {
      confirmDiscardChanges = async () => {
        discardPromptCalls += 1;
        return false;
      };
      cancelledCloseResult = await closeTab(dirtyCloseTab.id);
      retainedAfterCancel = isOpenTab(dirtyCloseTab) && state.tabs.includes(dirtyCloseTab);

      confirmDiscardChanges = async () => {
        discardPromptCalls += 1;
        return true;
      };
      confirmedCloseResult = await closeTab(dirtyCloseTab.id);
      removedAfterConfirm = !isOpenTab(dirtyCloseTab) && !state.tabs.includes(dirtyCloseTab);
    } finally {
      confirmDiscardChanges = originalConfirmDiscardChanges;
    }
    const dirtyClose = {
      cancelledCloseResult,
      confirmedCloseResult,
      retainedAfterCancel,
      removedAfterConfirm,
      discardPromptCalls
    };

    await openFile('C:\\\\QA\\\\reader-smoke.epub');
    await waitFor(() => {
      const book = state.tabs.find((tab) => tab.kind === 'epub');
      return book && book.epubView && (book.epubView.state === 'ready' || book.epubView.state === 'error');
    }, 15000);

    const book = state.tabs.find((tab) => tab.kind === 'epub');
    if (book.epubView.state !== 'ready') throw new Error(book.error || 'EPUB failed to open');
    const getBookDocument = () => [...book.host.querySelectorAll('iframe')]
      .map((frame) => frame.contentDocument)
      .find((document) => document?.querySelector('#publisher-font'));
    await waitFor(() => Boolean(getBookDocument()));
    if (!getBookDocument()) {
      const diagnostics = [...book.host.querySelectorAll('iframe')].map((frame) => ({
        src: frame.src,
        body: frame.contentDocument?.body?.innerHTML?.slice(0, 300) || null
      }));
      throw new Error('EPUB frame content missing: ' + JSON.stringify({
        diagnostics,
        frameHost: book.host.querySelector('.epub-frame-host')?.innerHTML || null,
        state: book.epubView.state,
        connected: book.host.isConnected,
        rect: book.host.getBoundingClientRect().toJSON()
      }));
    }
    let bookDocument = getBookDocument();
    const publisherFontBefore = bookDocument.querySelector('#publisher-font').style.getPropertyValue('font-family');
    const publisherPriority = bookDocument.querySelector('#publisher-font').style.getPropertyPriority('font-family');
    const codeFont = bookDocument.querySelector('#code-font').style.getPropertyValue('font-family');

    fontSelect.value = "'Atkinson Hyperlegible', sans-serif";
    fontSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      bookDocument = getBookDocument();
      return bookDocument?.querySelector('#publisher-font')?.style.getPropertyValue('font-family').includes('Atkinson');
    });
    const publisherFontAfter = bookDocument.querySelector('#publisher-font').style.getPropertyValue('font-family');
    const readerSnapshot = () => {
      const document = getBookDocument();
      const body = document?.body;
      const publisher = document?.querySelector('#publisher-font');
      return {
        frames: book.host.querySelectorAll('iframe').length,
        publisherFont: publisher?.style.getPropertyValue('font-family') || null,
        color: body ? document.defaultView.getComputedStyle(body).color : null,
        themePresent: Boolean(document?.getElementById('moth'))
      };
    };
    const readerTimeline = { afterSettings: readerSnapshot() };

    const moved = await book.epubView.goChapter('next');
    await waitFor(() => book.chapter === 'Second light');
    if (book.chapter !== 'Second light') {
      throw new Error('Chapter navigation failed: ' + JSON.stringify({
        moved,
        chapter: book.chapter,
        location: book.epubView.getCurrentLocation(),
        frames: [...book.host.querySelectorAll('iframe')].map((frame) => ({
          href: frame.contentDocument?.location?.href,
          rect: frame.getBoundingClientRect().toJSON(),
          parentRect: frame.parentElement?.getBoundingClientRect().toJSON()
        })),
        scrollTop: book.host.querySelector('.epub-container')?.scrollTop,
        scrollHeight: book.host.querySelector('.epub-container')?.scrollHeight,
        clientHeight: book.host.querySelector('.epub-container')?.clientHeight
      }));
    }
    readerTimeline.afterNavigation = readerSnapshot();

    activateTab(state.tabs[0].id);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const leftTabRect = document.querySelector('#tabs .tab.active').getBoundingClientRect();
    const leftTabsRect = document.querySelector('#tabs').getBoundingClientRect();
    const leftTabVisible = leftTabRect.left >= leftTabsRect.left - 1 && leftTabRect.right <= leftTabsRect.right + 1;
    activateTab(book.id);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const readerSurvivedSwitch = book.epubView.state === 'ready' && book.host.querySelectorAll('iframe').length > 0;
    readerTimeline.afterTabSwitch = readerSnapshot();

    await openFile('C:\\\\QA\\\\records.jsonl');
    const jsonlTab = state.tabs.find((tab) => tab.name === 'records.jsonl');
    await waitFor(() => Boolean(jsonlTab?.editorView));
    const jsonlLines = jsonlTab.editorView.state.doc.lines;
    const initialJsonlView = jsonlTab.editorView;
    const initialJsonlLanguage = getEditorLanguageName(initialJsonlView);

    updateTabPath(jsonlTab, 'C:\\\\QA\\\\records.md', 'records.md');
    await waitFor(() => jsonlTab.editorView
      && jsonlTab.editorView !== initialJsonlView
      && getEditorLanguageName(jsonlTab.editorView) === 'markdown');
    const markdownView = jsonlTab.editorView;
    const markdownLanguageAfterRename = getEditorLanguageName(markdownView);

    updateTabPath(jsonlTab, 'C:\\\\QA\\\\records.jsonl', 'records.jsonl');
    await waitFor(() => jsonlTab.editorView
      && jsonlTab.editorView !== markdownView
      && getEditorLanguageName(jsonlTab.editorView) === 'jsonl');
    const jsonlLanguage = getEditorLanguageName(jsonlTab.editorView);
    const languageRebuild = {
      initialJsonlLanguage,
      markdownLanguageAfterRename,
      restoredJsonlLanguage: jsonlLanguage,
      distinctViews: initialJsonlView !== markdownView && markdownView !== jsonlTab.editorView
    };
    readerTimeline.afterJsonl = readerSnapshot();

    await openFile('C:\\\\QA\\\\fixed-layout.epub');
    const fixedTab = state.tabs.find((tab) => tab.name === 'fixed-layout.epub');
    await waitFor(() => fixedTab?.epubView?.state === 'error');
    const fixedLayoutRejected = fixedTab.locationStatus === 'error'
      && /fixed-layout/i.test(fixedTab.error || '')
      && Boolean(fixedTab.host.querySelector('.epub-state.epub-error'));
    activateTab(book.id);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    readerTimeline.afterFixedLayout = readerSnapshot();
    const frameStyles = [...book.host.querySelectorAll('iframe')].map((frame) => {
      const body = frame.contentDocument?.body;
      if (!body) return null;
      const computed = frame.contentWindow.getComputedStyle(body);
      return {
        color: computed.color,
        background: computed.backgroundColor,
        rect: frame.getBoundingClientRect().toJSON(),
        bodyFont: body.style.getPropertyValue('font-family'),
        publisherFont: body.querySelector('#publisher-font')?.style.getPropertyValue('font-family') || null,
        themePresent: Boolean(frame.contentDocument.getElementById('moth'))
      };
    });
    const themeSurvivedSwitch = frameStyles.every((style) => style
      && style.color === 'rgb(204, 204, 204)'
      && style.background === 'rgb(38, 38, 38)');
    const fontSurvivedSwitch = getBookDocument()
      .querySelector('#publisher-font').style.getPropertyValue('font-family').includes('Atkinson');

    const tabsElement = document.querySelector('#tabs');
    const tabElements = [...tabsElement.querySelectorAll('.tab')];
    const widths = tabElements.map((tab) => Math.round(tab.getBoundingClientRect().width));
    const activeElement = tabsElement.querySelector('.tab.active');
    const activeRect = activeElement.getBoundingClientRect();
    const tabsRect = tabsElement.getBoundingClientRect();
    const newButtonRect = document.querySelector('#btn-new-file').getBoundingClientRect();
    const settingsRect = document.querySelector('#btn-settings').getBoundingClientRect();
    const inactiveClose = tabElements.find((tab) => !tab.classList.contains('active')).querySelector('.tab-close');

    return {
      smallTabLayout,
      tabCount: tabElements.length,
      tabOverflow: tabsElement.scrollWidth > tabsElement.clientWidth,
      tabMinWidth: Math.min(...widths),
      tabMaxWidth: Math.max(...widths),
      activeTabVisible: activeRect.left >= tabsRect.left - 1 && activeRect.right <= tabsRect.right + 1,
      leftTabVisible,
      fixedControlsVisible: newButtonRect.right <= innerWidth && settingsRect.right <= innerWidth,
      inactiveCloseOpacity: getComputedStyle(inactiveClose).opacity,
      tocCount: book.toc.length,
      readerMode: book.host.querySelector('.epub-container')?.style.overflow || 'continuous',
      publisherFontBefore,
      publisherPriority,
      publisherFontAfter,
      codeFont,
      currentChapter: book.chapter,
      readerSurvivedSwitch,
      themeSurvivedSwitch,
      fontSurvivedSwitch,
      frameStyles,
      readerScrollTop: book.host.querySelector('.epub-container')?.scrollTop,
      readerTimeline,
      saveRace,
      dirtyClose,
      jsonlLines,
      jsonlLanguage,
      languageRebuild,
      fixedLayoutRejected,
      sidebarMode: !document.querySelector('#epub-sidebar').classList.contains('hidden'),
      progressStored: Boolean(localStorage.getItem('moth-epub-progress-v1'))
    };
  })()`, true);

  window.setSize(600, 500);
  const narrowWindowExpression = `(() => {
    const tabs = document.querySelector('#tabs');
    const active = tabs.querySelector('.tab.active')?.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const newButton = document.querySelector('#btn-new-file').getBoundingClientRect();
    const settingsButton = document.querySelector('#btn-settings').getBoundingClientRect();
    const book = state.tabs.find((tab) => tab.kind === 'epub' && tab.epubView?.state === 'ready');
    const frames = [...(book?.host.querySelectorAll('iframe') || [])];
    const framesVisible = frames.some((frame) => {
      const rect = frame.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const themeIntact = frames.length > 0 && frames.every((frame) => {
      const body = frame.contentDocument?.body;
      if (!body) return false;
      const computed = frame.contentWindow.getComputedStyle(body);
      return computed.color === 'rgb(204, 204, 204)'
        && body.style.getPropertyValue('font-family').includes('Atkinson');
    });
    return {
      viewportWidth: innerWidth,
      controlsVisible: newButton.right <= innerWidth && settingsButton.right <= innerWidth,
      activeTabVisible: Boolean(active) && active.left >= tabsRect.left - 1 && active.right <= tabsRect.right + 1,
      tabsScrollable: tabs.scrollWidth > tabs.clientWidth,
      readerReady: book?.epubView?.state === 'ready',
      framesVisible,
      themeIntact
    };
  })()`;
  report.narrowWindow = await waitForRenderer(
    window,
    narrowWindowExpression,
    (value) => value.viewportWidth <= 600
      && value.controlsVisible
      && value.activeTabVisible
      && value.tabsScrollable
      && value.readerReady
      && value.framesVisible
      && value.themeIntact,
    'narrow window EPUB layout'
  );

  window.setSize(1100, 720);
  const readerPositionExpression = `(() => {
    const book = state.tabs.find((tab) => tab.kind === 'epub' && tab.epubView?.state === 'ready');
    const frame = [...(book?.host.querySelectorAll('iframe') || [])]
      .find((candidate) => candidate.contentDocument?.querySelector('h1')?.textContent === 'Second light');
    if (!book || !frame) return { viewportWidth: innerWidth, positioned: false, reason: 'chapter frame missing' };
    const frameRect = frame.getBoundingClientRect();
    const hostRect = book.host.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      positioned: frameRect.height > 0
        && frameRect.top >= hostRect.top - 4
        && frameRect.top <= hostRect.top + 100,
      frameTop: frameRect.top,
      frameHeight: frameRect.height,
      hostTop: hostRect.top
    };
  })()`;
  report.readerPosition = await waitForRenderer(
    window,
    readerPositionExpression,
    (value) => value.viewportWidth >= 1000 && value.positioned,
    'reader position after resize'
  );
  report.readerPositionAfterResize = report.readerPosition.positioned;

  const checks = {
    smallTabsNatural: report.smallTabLayout.widths.length === 2
      && report.smallTabLayout.firstWidthStable
      && report.smallTabLayout.noOverflow
      && report.smallTabLayout.widths.every((width) => width >= 79 && width <= 181),
    smallTabsCloseVisible: report.smallTabLayout.closeOpacities.every((opacity) => opacity === '1'),
    tabsCompressed: report.tabOverflow
      && report.tabMinWidth >= 79
      && report.tabMaxWidth <= 181
      && report.tabMinWidth < Math.min(...report.smallTabLayout.widths) - 5,
    activeTabVisible: report.activeTabVisible,
    leftTabVisible: report.leftTabVisible,
    controlsVisible: report.fixedControlsVisible,
    inactiveCloseHidden: report.inactiveCloseOpacity === '0',
    tocLoaded: report.tocCount === 2,
    publisherFontOverridden: /Lexend/.test(report.publisherFontBefore) && report.publisherPriority === 'important',
    settingsApplied: /Atkinson/.test(report.publisherFontAfter),
    codeFontPreserved: /Consolas/.test(report.codeFont),
    chapterNavigation: report.currentChapter === 'Second light',
    readerLifecycle: report.readerSurvivedSwitch,
    readerThemeLifecycle: report.themeSurvivedSwitch && report.fontSurvivedSwitch,
    saveSnapshotRace: report.saveRace.completed
      && report.saveRace.dirty
      && report.saveRace.writtenContent === report.saveRace.savedContent
      && report.saveRace.currentContent !== report.saveRace.savedContent,
    dirtyCloseFlow: report.dirtyClose.cancelledCloseResult === false
      && report.dirtyClose.retainedAfterCancel
      && report.dirtyClose.confirmedCloseResult === true
      && report.dirtyClose.removedAfterConfirm
      && report.dirtyClose.discardPromptCalls === 2,
    jsonlLineMode: report.jsonlLines === 2 && report.jsonlLanguage === 'jsonl',
    textLanguageRebuilt: report.languageRebuild.initialJsonlLanguage === 'jsonl'
      && report.languageRebuild.markdownLanguageAfterRename === 'markdown'
      && report.languageRebuild.restoredJsonlLanguage === 'jsonl'
      && report.languageRebuild.distinctViews,
    fixedLayoutRejected: report.fixedLayoutRejected,
    narrowWindowLayout: report.narrowWindow.controlsVisible
      && report.narrowWindow.activeTabVisible
      && report.narrowWindow.tabsScrollable,
    readerResizeLifecycle: report.narrowWindow.readerReady
      && report.narrowWindow.framesVisible
      && report.narrowWindow.themeIntact,
    readerPositionAfterResize: report.readerPositionAfterResize,
    epubSidebarVisible: report.sidebarMode,
    progressSaved: report.progressStored
  };
  report.checks = checks;

  const screenshotPath = path.join(app.getPath('temp'), 'moth-electron-qa.png');
  fs.writeFileSync(screenshotPath, (await window.capturePage()).toPNG());
  console.log(JSON.stringify({ ...report, fixturePath, screenshotPath }, null, 2));

  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`QA checks failed: ${Object.entries(checks).filter(([, value]) => !value).map(([key]) => key).join(', ')}`);
  }
  window.destroy();
}

app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  }
);

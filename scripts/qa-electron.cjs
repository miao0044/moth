const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(app.getPath('temp'), 'moth-electron-qa'));

const QA_ROOT = process.platform === 'win32' ? 'C:\\QA' : '/tmp/moth-qa';

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
  zip.file('OEBPS/chapter-1.xhtml', `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>First light</title><style>
    html { font-size: 7px !important; }
    body { font-family: fantasy !important; line-height: 1 !important; }
    .publisher-copy { font-size: 10px !important; line-height: 11px !important; margin: 0 !important; }
    .publisher-copy .publisher-leaf { color: #000 !important; font-size: 8px !important; line-height: 9px !important; }
  </style></head><body style="padding: 1px !important; margin: 20px !important;"><h1><span id="publisher-heading-color" style="color: #000 !important;">First light</span></h1><p id="publisher-font" class="publisher-copy" style="color: #000 !important; font-family: 'Courier New' !important; font-size: 6px !important; line-height: 7px !important; margin: 0 !important;"><span id="publisher-typography" class="publisher-leaf" style="color: #000 !important; font-size: 5px !important; line-height: 6px !important;">Publisher typography must not survive.</span></p><pre id="code-font">const moth = true;</pre><p>${'A quiet paragraph for continuous reading. '.repeat(80)}</p></body></html>`);
  const chapterTwoLead = 'Lead copy before the paragraph anchor keeps this section well away from its chapter boundary. '.repeat(90);
  const chapterTwoBetween = 'Between-anchor copy forces several viewports of real reflow before the list. '.repeat(90);
  const chapterTwoTail = 'Trailing copy prevents the list anchor from being clamped at the end of the scroll range. '.repeat(90);
  zip.file('OEBPS/chapter-2.xhtml', `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second light</title></head><body>
    <h1>Second light</h1>
    <p>${chapterTwoLead}</p>
    <p data-qa-anchor="paragraph" data-qa-token="MOTHQA7P"><span>MOTHQA7P</span> begins the paragraph context after the exact probe word.</p>
    <p>${chapterTwoBetween}</p>
    <ul>
      <li>${'List lead context. '.repeat(30)}</li>
      <li data-qa-anchor="list" data-qa-token="MOTHQA7L"><span>MOTHQA7L</span> begins the list context after the exact probe word.</li>
      <li>${'List tail context. '.repeat(30)}</li>
    </ul>
    <p>${chapterTwoTail}</p>
  </body></html>`);
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
  ipcMain.handle('window-is-maximized', () => false);
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

function closeNumber(actual, expected, tolerance = 0.25) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

async function run() {
  const [epub, fixedEpub] = await Promise.all([makeEpub(), makeEpub(true)]);
  registerIpc(epub, fixedEpub);
  const fixturePath = path.join(app.getPath('temp'), 'moth-reader-qa.epub');
  const appRoot = process.env.MOTH_QA_APP_ROOT
    ? path.resolve(process.env.MOTH_QA_APP_ROOT)
    : path.join(__dirname, '..');
  fs.writeFileSync(fixturePath, epub);

  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: true,
    backgroundColor: '#262626',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  await window.loadFile(path.join(appRoot, 'index.html'));

  const report = await window.webContents.executeJavaScript(`(async () => {
    const QA_ROOT = ${JSON.stringify(QA_ROOT)};
    const qaPath = (name) => require('path').join(QA_ROOT, name);
    const waitFor = async (test, timeout = 10000, label = 'renderer condition') => {
      const started = Date.now();
      while (!(await test())) {
        if (Date.now() - started > timeout) throw new Error('QA wait timed out (' + label + ')');
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

    await openFile(qaPath('save-race.md'));
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

    await openFile(qaPath('reader-smoke.epub'));
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
    const fontSizeInput = document.querySelector('#setting-font-size');
    const paddingInput = document.querySelector('#setting-padding');
    const spacingInput = document.querySelector('#setting-spacing');
    const numericCssValue = (value) => Number.parseFloat(value || '');
    const closeTo = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= 0.25;
    const expectedTypography = (spacing) => ({
      fontSize: 24,
      lineHeight: 24 * 1.7 * (spacing / 100),
      paragraphMargin: 24 * (spacing / 100),
      bodyPadding: { top: 30, right: 148, bottom: 64, left: 148 }
    });
    const publisherTypographySnapshot = () => {
      const document = getBookDocument();
      const paragraph = document?.querySelector('#publisher-font');
      const leaf = document?.querySelector('#publisher-typography');
      const heading = document?.querySelector('#publisher-heading-color');
      if (!paragraph || !leaf || !heading) return null;
      const paragraphStyle = document.defaultView.getComputedStyle(paragraph);
      const leafStyle = document.defaultView.getComputedStyle(leaf);
      const headingStyle = document.defaultView.getComputedStyle(heading);
      const bodyStyle = document.defaultView.getComputedStyle(document.body);
      return {
        paragraphFontSize: numericCssValue(paragraphStyle.fontSize),
        leafFontSize: numericCssValue(leafStyle.fontSize),
        paragraphColor: paragraphStyle.color,
        leafColor: leafStyle.color,
        headingColor: headingStyle.color,
        paragraphLineHeight: numericCssValue(paragraphStyle.lineHeight),
        leafLineHeight: numericCssValue(leafStyle.lineHeight),
        paragraphMarginTop: numericCssValue(paragraphStyle.marginTop),
        paragraphMarginBottom: numericCssValue(paragraphStyle.marginBottom),
        bodyMargin: numericCssValue(bodyStyle.marginTop),
        bodyPaddingTop: numericCssValue(bodyStyle.paddingTop),
        bodyPaddingRight: numericCssValue(bodyStyle.paddingRight),
        bodyPaddingBottom: numericCssValue(bodyStyle.paddingBottom),
        bodyPaddingLeft: numericCssValue(bodyStyle.paddingLeft),
        settingFontSize: settings.fontSize,
        settingPadding: settings.padding,
        settingSpacing: settings.spacing
      };
    };
    const typographyMatches = (snapshot, expected, spacing) => Boolean(snapshot)
      && snapshot.settingFontSize === 24
      && snapshot.settingPadding === 148
      && snapshot.settingSpacing === spacing
      && closeTo(snapshot.paragraphFontSize, expected.fontSize)
      && closeTo(snapshot.leafFontSize, expected.fontSize)
      && snapshot.paragraphColor === 'rgb(204, 204, 204)'
      && snapshot.leafColor === 'rgb(204, 204, 204)'
      && snapshot.headingColor === 'rgb(224, 224, 224)'
      && closeTo(snapshot.paragraphLineHeight, expected.lineHeight)
      && closeTo(snapshot.leafLineHeight, expected.lineHeight)
      && closeTo(snapshot.paragraphMarginTop, expected.paragraphMargin)
      && closeTo(snapshot.paragraphMarginBottom, expected.paragraphMargin)
      && closeTo(snapshot.bodyMargin, 0)
      && closeTo(snapshot.bodyPaddingTop, expected.bodyPadding.top)
      && closeTo(snapshot.bodyPaddingRight, expected.bodyPadding.right)
      && closeTo(snapshot.bodyPaddingBottom, expected.bodyPadding.bottom)
      && closeTo(snapshot.bodyPaddingLeft, expected.bodyPadding.left);

    fontSizeInput.value = '24';
    fontSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    paddingInput.value = '148';
    paddingInput.dispatchEvent(new Event('input', { bubbles: true }));
    spacingInput.value = '60';
    spacingInput.dispatchEvent(new Event('input', { bubbles: true }));
    const lowSpacingExpected = expectedTypography(60);
    await waitFor(() => typographyMatches(
      publisherTypographySnapshot(),
      lowSpacingExpected,
      60
    ), 10000, 'EPUB low-spacing typography override');
    const lowSpacing = publisherTypographySnapshot();

    for (const spacing of [195, 75, 200, 115, 175]) {
      spacingInput.value = String(spacing);
      spacingInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const finalSpacingExpected = expectedTypography(175);
    await waitFor(() => typographyMatches(
      publisherTypographySnapshot(),
      finalSpacingExpected,
      175
    ), 10000, 'EPUB rapid final typography override');
    const finalSpacing = publisherTypographySnapshot();
    const epubTypography = {
      lowSpacing,
      finalSpacing,
      lowSpacingExpected,
      finalSpacingExpected
    };
    const readerAnchorSnapshot = () => {
      const location = book.epubView.getCurrentLocation() || {};
      const frames = [...book.host.querySelectorAll('iframe')];
      const frame = frames.find((candidate) => candidate.contentDocument
        ?.querySelector('h1')?.textContent === book.chapter) || frames[0];
      const frameRect = frame?.getBoundingClientRect();
      const hostRect = book.host.getBoundingClientRect();
      return {
        chapter: book.chapter || null,
        cfi: location.cfi || book.cfi || null,
        href: location.href || book.href || null,
        index: Number.isFinite(location.index) ? location.index : null,
        frameOffset: frameRect ? frameRect.top - hostRect.top : null,
        hostWidth: hostRect.width,
        frameCount: frames.length
      };
    };
    const wordSnapshot = (name) => {
      const frames = [...book.host.querySelectorAll('iframe')];
      for (const frame of frames) {
        const document = frame.contentDocument;
        const marker = document?.querySelector('[data-qa-anchor="' + name + '"]');
        const token = marker?.dataset.qaToken;
        if (!marker || !token) continue;

        const walker = document.createTreeWalker(
          marker,
          document.defaultView.NodeFilter.SHOW_TEXT
        );
        let node = null;
        let offset = -1;
        while ((node = walker.nextNode())) {
          offset = node.data.indexOf(token);
          if (offset >= 0) break;
        }
        if (!node || offset < 0) return null;

        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + token.length);
        const wordRect = range.getClientRects()[0] || range.getBoundingClientRect();
        const frameRect = frame.getBoundingClientRect();
        const hostRect = book.host.getBoundingClientRect();
        const y = frameRect.top + wordRect.top - hostRect.top;
        return {
          name,
          token,
          text: range.toString(),
          chapter: document.querySelector('h1')?.textContent?.trim() || null,
          href: document.location.href,
          y,
          height: wordRect.height,
          visible: Number.isFinite(y)
            && y >= 0
            && y + wordRect.height <= hostRect.height,
          scrollTop: book.host.querySelector('.epub-container')?.scrollTop ?? null
        };
      }
      return null;
    };
    const sameWordAtSameY = (before, after) => Boolean(before && after)
      && before.name === after.name
      && before.token === after.token
      && before.text === after.text
      && before.chapter === after.chapter
      && before.visible
      && after.visible
      && Math.abs(before.y - after.y) <= 4;
    const positionWordAt = async (name, options = {}) => {
      const targetY = Number.isFinite(options.targetY) ? options.targetY : 210;
      const waitForReportedLocation = options.waitForReportedLocation !== false;
      const container = book.host.querySelector('.epub-container');
      const initial = wordSnapshot(name);
      const locationBefore = book.epubView.getCurrentLocation() || {};
      if (!container || !initial) throw new Error('Missing QA word anchor: ' + name);
      const movedToTarget = Math.abs(initial.y - targetY) > 3;

      container.scrollTop += initial.y - targetY;
      const immediate = wordSnapshot(name);
      if (!immediate || !immediate.visible || Math.abs(immediate.y - targetY) > 3) {
        throw new Error('Could not position QA word anchor: ' + JSON.stringify({
          name,
          targetY,
          initial,
          immediate,
          scrollHeight: container?.scrollHeight,
          clientHeight: container?.clientHeight
        }));
      }

      if (waitForReportedLocation) {
        await waitFor(() => {
          const current = wordSnapshot(name);
          const location = book.epubView.getCurrentLocation() || {};
          return current?.visible
            && Math.abs(current.y - targetY) <= 3
            && location.cfi
            && (!movedToTarget || location.cfi !== locationBefore.cfi);
        }, 5000, name + ' word placement/location report');
        await nextPaint();
      }

      const locationAfter = book.epubView.getCurrentLocation() || {};
      return {
        name,
        targetY,
        waitForReportedLocation,
        locationBefore: locationBefore.cfi || null,
        locationAfter: locationAfter.cfi || null,
        cachedLocationUnchanged: locationBefore.cfi === locationAfter.cfi,
        word: wordSnapshot(name)
      };
    };
    const anchorMatches = (before, after) => Boolean(before?.cfi && after?.cfi)
      && before.chapter === after.chapter
      && before.cfi === after.cfi
      && before.href === after.href
      && before.index === after.index
      && Number.isFinite(before.frameOffset)
      && Number.isFinite(after.frameOffset)
      && Math.abs(before.frameOffset - after.frameOffset) <= 4;
    const exerciseSidebarToggle = async (label, trigger, expectCollapsed, expandedWidth, wordName) => {
      await waitFor(() => {
        const anchor = readerAnchorSnapshot();
        return Boolean(anchor.cfi && anchor.href && Number.isFinite(anchor.frameOffset));
      }, 5000, label + ' initial anchor');
      const before = readerAnchorSnapshot();
      const wordBefore = wordSnapshot(wordName);
      if (!wordBefore?.visible) {
        throw new Error(label + ' word anchor is not visible: ' + JSON.stringify(wordBefore));
      }
      const frameHost = book.host.querySelector('.epub-frame-host');
      const rebuilds = [];
      let lastRebuildAt = 0;
      const observer = new MutationObserver((records) => {
        let removedViews = 0;
        for (const record of records) {
          for (const node of record.removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches?.('.epub-view, iframe') || node.querySelector?.('iframe')) {
              removedViews += 1;
            }
          }
        }
        if (removedViews > 0) {
          lastRebuildAt = performance.now();
          rebuilds.push({
            removedViews,
            sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width,
            hostWidth: book.host.getBoundingClientRect().width
          });
        }
      });
      observer.observe(frameHost, { childList: true, subtree: true });

      try {
        trigger();
        await waitFor(() => document.querySelector('#sidebar')
          .classList.contains('collapsed') === expectCollapsed, 2000, label + ' class toggle');
        await waitFor(() => {
          const width = document.querySelector('#sidebar').getBoundingClientRect().width;
          return expectCollapsed ? width <= 0.5 : Math.abs(width - expandedWidth) <= 0.5;
        }, 3000, label + ' width transition');
        await waitFor(() => rebuilds.length >= 1, 5000, label + ' EPUB view rebuild');
        await waitFor(() => performance.now() - lastRebuildAt >= 1700, 7000, label + ' rebuild settle');
        await waitFor(() => {
          const anchor = readerAnchorSnapshot();
          return Boolean(anchor.cfi && anchor.href && Number.isFinite(anchor.frameOffset));
        }, 5000, label + ' final anchor');
        await nextPaint();
      } finally {
        observer.disconnect();
      }

      const after = readerAnchorSnapshot();
      const wordAfter = wordSnapshot(wordName);
      return {
        label,
        wordName,
        rebuildCount: rebuilds.length,
        rebuilds,
        before,
        after,
        wordBefore,
        wordAfter,
        wordStable: sameWordAtSameY(wordBefore, wordAfter),
        anchorStable: anchorMatches(before, after),
        collapsed: document.querySelector('#sidebar').classList.contains('collapsed')
      };
    };
    const readerSnapshot = () => {
      const document = getBookDocument();
      const body = document?.body;
      const publisher = document?.querySelector('#publisher-font');
      return {
        frames: book.host.querySelectorAll('iframe').length,
        publisherFont: publisher?.style.getPropertyValue('font-family') || null,
        color: body ? document.defaultView.getComputedStyle(body).color : null,
        themePresent: Boolean(document?.getElementById('epubjs-inserted-css-moth-theme'))
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

    const sidebar = document.querySelector('#sidebar');
    const expandedSidebarWidth = sidebar.getBoundingClientRect().width;
    const paragraphPlacement = await positionWordAt('paragraph');
    const sidebarToggleResize = {
      paragraphPlacement,
      clickCollapse: await exerciseSidebarToggle(
        'paragraph sidebar button collapse',
        () => document.querySelector('#btn-toggle-sidebar').click(),
        true,
        expandedSidebarWidth,
        'paragraph'
      )
    };
    sidebarToggleResize.keyboardExpand = await exerciseSidebarToggle(
      'paragraph Ctrl+B sidebar expand',
      () => document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'b',
        code: 'KeyB',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })),
      false,
      expandedSidebarWidth,
      'paragraph'
    );
    sidebarToggleResize.finalAnchorStable = anchorMatches(
      sidebarToggleResize.clickCollapse.before,
      sidebarToggleResize.keyboardExpand.after
    );
    sidebarToggleResize.paragraphRoundTripWordStable = sameWordAtSameY(
      sidebarToggleResize.clickCollapse.wordBefore,
      sidebarToggleResize.keyboardExpand.wordAfter
    );

    // Keep this placement and toggle in the same rendering turn. The visual
    // scroll position is already updated, but EPUB.js has not emitted its
    // delayed relocated callback yet. Resize anchoring must read the live text
    // position rather than restoring the controller's older cached CFI.
    sidebarToggleResize.listImmediatePlacement = await positionWordAt('list', {
      waitForReportedLocation: false
    });
    sidebarToggleResize.listClickCollapse = await exerciseSidebarToggle(
      'list immediate sidebar button collapse',
      () => document.querySelector('#btn-toggle-sidebar').click(),
      true,
      expandedSidebarWidth,
      'list'
    );

    // Reposition after the race so the reverse direction independently tests
    // a settled, reported CFI in real list content.
    sidebarToggleResize.listReportedPlacement = await positionWordAt('list');
    sidebarToggleResize.listKeyboardExpand = await exerciseSidebarToggle(
      'list Ctrl+B sidebar expand',
      () => document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'b',
        code: 'KeyB',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })),
      false,
      expandedSidebarWidth,
      'list'
    );
    sidebarToggleResize.listRoundTripWordStable = sameWordAtSameY(
      sidebarToggleResize.listClickCollapse.wordBefore,
      sidebarToggleResize.listKeyboardExpand.wordAfter
    );

    // Preserve the legacy later resize assertion, which intentionally checks
    // a chapter-level target after the window itself changes size.
    await book.epubView.display('chapter-2.xhtml');

    activateTab(state.tabs[0].id);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const leftTabRect = document.querySelector('#tabs .tab.active').getBoundingClientRect();
    const leftTabsRect = document.querySelector('#tabs').getBoundingClientRect();
    const leftTabVisible = leftTabRect.left >= leftTabsRect.left - 1 && leftTabRect.right <= leftTabsRect.right + 1;
    activateTab(book.id);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const readerSurvivedSwitch = book.epubView.state === 'ready' && book.host.querySelectorAll('iframe').length > 0;
    readerTimeline.afterTabSwitch = readerSnapshot();

    await openFile(qaPath('records.jsonl'));
    const jsonlTab = state.tabs.find((tab) => tab.name === 'records.jsonl');
    await waitFor(() => Boolean(jsonlTab?.editorView));
    const jsonlLines = jsonlTab.editorView.state.doc.lines;
    const initialJsonlView = jsonlTab.editorView;
    const initialJsonlLanguage = getEditorLanguageName(initialJsonlView);

    updateTabPath(jsonlTab, qaPath('records.md'), 'records.md');
    await waitFor(() => jsonlTab.editorView
      && jsonlTab.editorView !== initialJsonlView
      && getEditorLanguageName(jsonlTab.editorView) === 'markdown');
    const markdownView = jsonlTab.editorView;
    const markdownLanguageAfterRename = getEditorLanguageName(markdownView);

    updateTabPath(jsonlTab, qaPath('records.jsonl'), 'records.jsonl');
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

    await openFile(qaPath('fixed-layout.epub'));
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
        themePresent: Boolean(frame.contentDocument.getElementById('epubjs-inserted-css-moth-theme'))
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
      epubTypography,
      sidebarToggleResize,
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
    publisherFontSizeOverridden: closeNumber(report.epubTypography.finalSpacing.paragraphFontSize, 24)
      && closeNumber(report.epubTypography.finalSpacing.leafFontSize, 24),
    publisherColorOverridden: report.epubTypography.finalSpacing.paragraphColor === 'rgb(204, 204, 204)'
      && report.epubTypography.finalSpacing.leafColor === 'rgb(204, 204, 204)'
      && report.epubTypography.finalSpacing.headingColor === 'rgb(224, 224, 224)',
    publisherPaddingOverridden: closeNumber(report.epubTypography.finalSpacing.bodyMargin, 0)
      && closeNumber(report.epubTypography.finalSpacing.bodyPaddingTop, 30)
      && closeNumber(report.epubTypography.finalSpacing.bodyPaddingRight, 148)
      && closeNumber(report.epubTypography.finalSpacing.bodyPaddingBottom, 64)
      && closeNumber(report.epubTypography.finalSpacing.bodyPaddingLeft, 148),
    publisherSpacingOverridden: closeNumber(
      report.epubTypography.lowSpacing.paragraphLineHeight,
      report.epubTypography.lowSpacingExpected.lineHeight
    )
      && closeNumber(
        report.epubTypography.lowSpacing.leafLineHeight,
        report.epubTypography.lowSpacingExpected.lineHeight
      )
      && closeNumber(
        report.epubTypography.lowSpacing.paragraphMarginTop,
        report.epubTypography.lowSpacingExpected.paragraphMargin
      )
      && closeNumber(
        report.epubTypography.finalSpacing.paragraphLineHeight,
        report.epubTypography.finalSpacingExpected.lineHeight
      )
      && closeNumber(
        report.epubTypography.finalSpacing.leafLineHeight,
        report.epubTypography.finalSpacingExpected.lineHeight
      )
      && closeNumber(
        report.epubTypography.finalSpacing.paragraphMarginBottom,
        report.epubTypography.finalSpacingExpected.paragraphMargin
      ),
    rapidEpubSettingsApplied: report.epubTypography.finalSpacing.settingFontSize === 24
      && report.epubTypography.finalSpacing.settingSpacing === 175
      && report.epubTypography.finalSpacing.paragraphLineHeight
        > report.epubTypography.lowSpacing.paragraphLineHeight,
    sidebarToggleSingleRebuild: report.sidebarToggleResize.clickCollapse.rebuildCount === 1
      && report.sidebarToggleResize.keyboardExpand.rebuildCount === 1
      && report.sidebarToggleResize.listClickCollapse.rebuildCount === 1
      && report.sidebarToggleResize.listKeyboardExpand.rebuildCount === 1,
    sidebarToggleAnchorStable: report.sidebarToggleResize.clickCollapse.wordStable
      && report.sidebarToggleResize.keyboardExpand.wordStable
      && report.sidebarToggleResize.paragraphRoundTripWordStable
      && report.sidebarToggleResize.listClickCollapse.wordStable
      && report.sidebarToggleResize.listKeyboardExpand.wordStable
      && report.sidebarToggleResize.listRoundTripWordStable
      && report.sidebarToggleResize.clickCollapse.collapsed
      && !report.sidebarToggleResize.keyboardExpand.collapsed
      && report.sidebarToggleResize.listClickCollapse.collapsed
      && !report.sidebarToggleResize.listKeyboardExpand.collapsed,
    sidebarToggleLiveAnchorRace: report.sidebarToggleResize.listImmediatePlacement.cachedLocationUnchanged
      && report.sidebarToggleResize.listClickCollapse.wordStable,
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

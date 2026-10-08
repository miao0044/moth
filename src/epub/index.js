import ePub from 'epubjs';
import {
  buildFontFaceCss,
  buildThemeCss,
  enforceTypography,
  mergeSettings,
  normalizeSettings,
} from './theme.js';

const DEFAULT_LOCATION_BREAK = 1600;
const RESIZE_SETTLE_FRAMES = 2;
const PREPARED_RESIZE_TTL = 1500;
const TEXT_ANCHOR_VIEWPORT_RATIO = 0.32;
const TEXT_ANCHOR_MAX_OFFSET = 220;
const FONT_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

const SURFACE_CSS = `
  .epub-surface {
    position: absolute;
    inset: 0;
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--bg, #262626);
  }
  .epub-frame-host {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .epub-frame-host > div,
  .epub-frame-host .epub-container {
    width: 100% !important;
    height: 100% !important;
  }
  .epub-frame-host .epub-container::after {
    content: "";
    display: block;
    height: calc(100% - 72px);
    pointer-events: none;
  }
  .epub-frame-host.epub-reflowing .epub-container {
    visibility: hidden;
  }
  .epub-state {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 32px;
    background: var(--bg, #262626);
    color: var(--text-muted, #888);
    text-align: center;
    z-index: 1;
  }
  .epub-state.epub-loading,
  .epub-state.epub-error { display: flex; }
  .epub-state-card { max-width: 440px; }
  .epub-state-title {
    margin-bottom: 8px;
    color: var(--text-bright, #e0e0e0);
    font-size: 16px;
    font-weight: 500;
  }
  .epub-state-detail { font-size: 13px; line-height: 1.6; }
  .epub-spinner {
    width: 22px;
    height: 22px;
    margin: 0 auto 16px;
    border: 2px solid var(--border, #333);
    border-top-color: var(--text-muted, #888);
    border-radius: 50%;
    animation: moth-epub-spin 0.8s linear infinite;
  }
  @keyframes moth-epub-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .epub-spinner { animation: none; } }
`;

const ERROR_MESSAGES = Object.freeze({
  EPUB_FIXED_LAYOUT: {
    title: 'Fixed-layout EPUB not supported',
    detail: 'Moth currently reads reflowable EPUB books only.',
  },
  EPUB_DRM: {
    title: 'Protected EPUB not supported',
    detail: 'This book appears to use DRM or unsupported content encryption.',
  },
  EPUB_INVALID: {
    title: 'This EPUB can’t be opened',
    detail: 'The file is damaged, incomplete, or is not a valid EPUB book.',
  },
  EPUB_DESTROYED: {
    title: 'EPUB reader closed',
    detail: 'The reader was closed before the book finished loading.',
  },
  EPUB_OPEN_FAILED: {
    title: 'This EPUB can’t be opened',
    detail: 'Moth could not read this book. It may be damaged or protected with DRM.',
  },
});

class EpubViewError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EpubViewError';
    this.code = code;
    if (cause && !this.cause) this.cause = cause;
  }
}

function createSurfaceDom(parent) {
  const root = document.createElement('div');
  root.className = 'epub-surface';

  const style = document.createElement('style');
  style.dataset.mothEpubSurface = '';
  style.textContent = SURFACE_CSS;

  const frameHost = document.createElement('div');
  frameHost.className = 'epub-frame-host';

  const state = document.createElement('div');
  state.className = 'epub-state epub-loading';
  state.setAttribute('role', 'status');
  state.setAttribute('aria-live', 'polite');

  root.append(style, frameHost, state);
  parent.appendChild(root);
  return { root, frameHost, state };
}

function showLoading(state, detail = 'Opening EPUB…') {
  state.className = 'epub-state epub-loading';
  state.setAttribute('role', 'status');
  state.replaceChildren();

  const card = document.createElement('div');
  card.className = 'epub-state-card';
  const spinner = document.createElement('div');
  spinner.className = 'epub-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('div');
  text.className = 'epub-state-detail';
  text.textContent = detail;
  card.append(spinner, text);
  state.appendChild(card);
}

function hideState(state) {
  state.className = 'epub-state';
  state.replaceChildren();
  state.removeAttribute('role');
}

function showError(state, error) {
  const copy = ERROR_MESSAGES[error.code] || ERROR_MESSAGES.EPUB_OPEN_FAILED;
  state.className = 'epub-state epub-error';
  state.setAttribute('role', 'alert');
  state.replaceChildren();

  const card = document.createElement('div');
  card.className = 'epub-state-card';
  const title = document.createElement('div');
  title.className = 'epub-state-title';
  title.textContent = copy.title;
  const detail = document.createElement('div');
  detail.className = 'epub-state-detail';
  detail.textContent = copy.detail;
  card.append(title, detail);
  state.appendChild(card);
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
    return new Uint8Array(data).slice().buffer;
  }
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
    return Uint8Array.from(data.data).buffer;
  }
  if (data && data.data && data.data !== data) return toArrayBuffer(data.data);
  throw new EpubViewError('EPUB_INVALID', 'Expected EPUB data as an ArrayBuffer or typed array.');
}

function classifyError(error) {
  if (error instanceof EpubViewError) return error;
  const message = String(error?.message || error || 'Unable to open EPUB.');
  const code = /drm|encrypt|decrypt|rights/i.test(message)
    ? 'EPUB_DRM'
    : /zip|central directory|container\.xml|package|opf|invalid|corrupt|unrecognized/i.test(message)
      ? 'EPUB_INVALID'
      : 'EPUB_OPEN_FAILED';
  return new EpubViewError(code, message, error);
}

function safeCallback(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch (error) {
    console.error('Moth EPUB callback failed:', error);
  }
}

function copyToc(items = []) {
  return items.map((item) => ({
    id: item.id || item.href || '',
    href: item.href || '',
    label: String(item.label || '').trim() || 'Untitled chapter',
    parent: item.parent || null,
    subitems: copyToc(item.subitems || []),
  }));
}

function flattenToc(items, output = []) {
  for (const item of items) {
    output.push(item);
    flattenToc(item.subitems || [], output);
  }
  return output;
}

function comparableHref(href) {
  if (!href) return '';
  const withoutFragment = String(href).split('#')[0].split('?')[0].replace(/^\.\//, '');
  try {
    return decodeURIComponent(withoutFragment).replace(/^\/+/, '');
  } catch {
    return withoutFragment.replace(/^\/+/, '');
  }
}

function findChapter(flatToc, href) {
  const comparable = comparableHref(href);
  if (!comparable) return null;
  const matches = flatToc.filter((item) => comparableHref(item.href) === comparable);
  if (!matches.length) return null;
  const chapter = matches.find((item) => !String(item.href).includes('#')) || matches[0];
  return {
    id: chapter.id,
    href: chapter.href,
    label: chapter.label,
    parent: chapter.parent,
  };
}

function isFixedLayout(metadata, spine, displayOptions) {
  const layout = String(metadata?.layout || '').toLowerCase();
  if (layout === 'pre-paginated' || layout === 'fixed') return true;
  if (String(displayOptions?.fixedLayout || '').toLowerCase() === 'true') return true;
  const items = Array.isArray(spine) ? spine : (spine?.spineItems || []);
  return items.some((item) => (item.properties || []).some((property) =>
    String(property).toLowerCase().includes('layout-pre-paginated')));
}

async function hasUnsupportedEncryption(book) {
  const archive = book?.archive;
  if (!archive?.zip?.file) return false;
  const entry = archive.zip.file('META-INF/encryption.xml');
  if (!entry) return false;

  const source = await entry.async('string');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  const encrypted = [...document.getElementsByTagNameNS('*', 'EncryptedData')];
  if (!encrypted.length) return false;

  const algorithms = [...document.getElementsByTagNameNS('*', 'EncryptionMethod')]
    .map((node) => node.getAttribute('Algorithm'))
    .filter(Boolean);
  return !algorithms.length || algorithms.some((algorithm) => !FONT_OBFUSCATION_ALGORITHMS.has(algorithm));
}

function currentCfi(rendition, fallback) {
  try {
    const location = rendition?.currentLocation?.();
    if (location && typeof location.then !== 'function') return location.start?.cfi || fallback || null;
  } catch {
    // A detached or not-yet-rendered rendition has no synchronous location.
  }
  return fallback || null;
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function displayInitialSection(rendition, target) {
  let renderedHandler;
  let errorHandler;
  const rendered = new Promise((resolve, reject) => {
    renderedHandler = () => resolve();
    errorHandler = (cause) => reject(cause || new Error('EPUB section failed to render.'));
    rendition.on('rendered', renderedHandler);
    rendition.on('displayerror', errorHandler);
  });

  try {
    // In continuous mode EPUB.js can resolve display() before the asynchronously
    // added iframe has run rendition content hooks. `ready` should only resolve
    // once the first real section (and the Moth font override) is present.
    await Promise.all([rendition.display(target), rendered]);
  } finally {
    rendition.off('rendered', renderedHandler);
    rendition.off('displayerror', errorHandler);
  }
}

function resizeAndWaitForSection(rendition, width, height, target) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    const rendered = (section, view) => {
      cleanup();
      resolve({ section, view });
    };
    const failed = (cause) => {
      cleanup();
      reject(cause || new Error('EPUB section failed to render after resizing.'));
    };
    const cleanup = () => {
      rendition.off('rendered', rendered);
      rendition.off('displayerror', failed);
      clearTimeout(timeoutId);
    };

    rendition.on('rendered', rendered);
    rendition.on('displayerror', failed);
    timeoutId = setTimeout(() => {
      const stageSize = rendition?.manager?._stageSize;
      const hasViews = (rendition?.manager?.views?.length || 0) > 0;
      const sizeApplied = Math.abs((stageSize?.width || 0) - width) < 1
        && Math.abs((stageSize?.height || 0) - height) < 1;
      if (sizeApplied && hasViews) {
        cleanup();
        resolve(null);
      } else {
        failed(new Error('EPUB resize did not finish rendering.'));
      }
    }, 1200);
    try {
      // Rendition.resize() is synchronous, but EPUB.js clears every view and
      // starts an unreturned display() from its resized event. Waiting for the
      // real rendered event prevents a competing display() from racing it.
      rendition.resize(width, height, target);
    } catch (error) {
      failed(error);
    }
  });
}

async function waitForRenditionLayout(rendition) {
  const fontReadiness = rendition.getContents()
    .map((content) => content?.document?.fonts?.ready)
    .filter(Boolean);
  if (fontReadiness.length) {
    let timeoutId;
    try {
      await Promise.race([
        Promise.all(fontReadiness).catch(() => {}),
        new Promise((resolve) => {
          timeoutId = setTimeout(resolve, 350);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  let previousGeometry = '';
  let stableFrames = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    await nextAnimationFrame();
    const views = rendition?.manager?.views?.all?.() || [];
    const geometry = views.map((view) => {
      const height = view?.element?.getBoundingClientRect?.().height || 0;
      const scrollHeight = view?.contents?.document?.documentElement?.scrollHeight || 0;
      return `${height.toFixed(2)}:${scrollHeight}`;
    }).join('|');
    if (geometry && geometry === previousGeometry) stableFrames += 1;
    else stableFrames = 0;
    if (stableFrames >= 2) return;
    previousGeometry = geometry;
  }
}

function createEpubView(parent, data, options = {}) {
  if (!parent || typeof parent.appendChild !== 'function') {
    throw new TypeError('createEpubView requires a parent DOM element.');
  }

  const callbacks = {
    onToc: options.onToc,
    onRelocated: options.onRelocated,
    onProgress: options.onProgress,
    onError: options.onError,
    onReady: options.onReady,
  };
  const locationBreak = Math.round(Math.max(100, Number(options.locationBreak) || DEFAULT_LOCATION_BREAK));
  const dom = createSurfaceDom(parent);
  showLoading(dom.state);

  let phase = 'loading';
  let book = null;
  let bookOpenSettled = Promise.resolve();
  let rendition = null;
  let metadata = null;
  let toc = [];
  let flatToc = [];
  let settings = normalizeSettings(options.settings);
  let lastLocation = null;
  let locationsReady = false;
  let locationCount = 0;
  let resizeObserver = null;
  let contentHook = null;
  let renderedHandler = null;
  let relocatedHandler = null;
  let settingsVersion = 0;
  let settingsTask = null;
  let settingsMutating = false;
  let settingsAnchor = null;
  let lastWidth = 0;
  let lastHeight = 0;
  let requestedWidth = 0;
  let requestedHeight = 0;
  let pendingResize = null;
  let resizeFrame = null;
  let resizeTask = null;
  let resizeAnchor = null;
  let preparedResizeAnchor = null;
  let preparedResizeUntil = 0;
  let resizeStableFrames = 0;
  let locationSuppressionCount = 0;
  let navigationMutating = false;
  let guardedLocationIndex = null;
  let guardedLocationUntil = 0;
  const settingsWaiters = [];

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Consumers normally observe `ready`, but a tab may be closed immediately.
  // Registering a rejection handler prevents that valid lifecycle from creating
  // an unhandled-rejection warning.
  ready.catch(() => {});

  function assertUsable() {
    if (phase === 'destroyed') {
      throw new EpubViewError('EPUB_DESTROYED', 'The EPUB reader has been destroyed.');
    }
    if (phase === 'error') {
      throw new EpubViewError('EPUB_OPEN_FAILED', 'The EPUB reader is unavailable.');
    }
  }

  function emitError(input, fatal) {
    const error = classifyError(input);
    safeCallback(callbacks.onError, {
      code: error.code,
      message: error.message,
      cause: error.cause || input,
      fatal,
    });
    return error;
  }

  function percentageFor(cfi, rawLocation) {
    if (locationsReady && cfi) {
      try {
        const value = book.locations.percentageFromCfi(cfi);
        if (Number.isFinite(value)) return Math.min(1, Math.max(0, value));
      } catch {
        // A malformed CFI still has useful chapter-level location data.
      }
    }
    const value = rawLocation?.start?.percentage;
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  }

  function locationPayload(location) {
    const start = location?.start || {};
    const payload = {
      cfi: start.cfi || null,
      href: start.href || null,
      index: Number.isFinite(start.index) ? start.index : null,
      chapter: findChapter(flatToc, start.href),
      percentage: percentageFor(start.cfi, location),
      atStart: Boolean(location?.atStart),
      atEnd: Boolean(location?.atEnd),
      location,
    };
    if (payload.cfi) lastLocation = payload;
    return payload;
  }

  function emitLocation(location) {
    if (phase === 'destroyed') return;
    if (locationSuppressionCount > 0) return;
    const surfaceRect = dom.frameHost.getBoundingClientRect();
    if (surfaceRect.width < 1 || surfaceRect.height < 1) return;

    const incomingIndex = location?.start?.index;
    if (Number.isFinite(guardedLocationIndex)
      && Number.isFinite(incomingIndex)
      && incomingIndex !== guardedLocationIndex) {
      const internallyMutating = navigationMutating
        || settingsMutating
        || Boolean(resizeTask)
        || resizeFrame !== null
        || Boolean(pendingResize);
      let currentIndex = null;
      try {
        const current = rendition?.currentLocation?.();
        if (current && typeof current.then !== 'function') currentIndex = current.start?.index;
      } catch {
        // A transient manager location must not replace the guarded chapter.
      }
      if (internallyMutating || Date.now() < guardedLocationUntil || currentIndex !== incomingIndex) return;
      guardedLocationIndex = null;
      guardedLocationUntil = 0;
    }

    const payload = locationPayload(location);
    safeCallback(callbacks.onRelocated, payload);
    safeCallback(callbacks.onProgress, {
      status: locationsReady ? 'ready' : 'generating',
      percentage: payload.percentage,
      locations: locationCount,
      cfi: payload.cfi,
    });
  }

  function suppressLocations() {
    locationSuppressionCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      locationSuppressionCount = Math.max(0, locationSuppressionCount - 1);
    };
  }

  function guardLocation(target) {
    const section = book?.spine?.get(target);
    if (Number.isFinite(section?.index)) {
      guardedLocationIndex = section.index;
      guardedLocationUntil = Date.now() + 250;
    }
  }

  function updateTheme() {
    if (!rendition) return;
    const css = buildThemeCss(settings);
    for (const contents of rendition.getContents()) {
      contents.addStylesheetCss(css, 'moth-theme');
      enforceTypography(contents, settings);
    }
  }

  function applyThemeToContents(contents) {
    contents.addStylesheetCss(buildFontFaceCss(), 'moth-fonts');
    contents.addStylesheetCss(buildThemeCss(settings), 'moth-theme');
    enforceTypography(contents, settings);
  }

  function measuredSize(width, height) {
    const rect = dom.frameHost.getBoundingClientRect();
    const resolvedWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : rect.width;
    const resolvedHeight = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : rect.height;
    return {
      width: Math.floor(resolvedWidth),
      height: Math.floor(resolvedHeight),
    };
  }

  function prepareResize() {
    if (!rendition || phase !== 'ready') return false;
    if (resizeAnchor || pendingResize || resizeFrame !== null || resizeTask) return true;
    const anchor = captureResizeAnchor(lastLocation?.cfi || currentCfi(rendition));
    if (!anchor) return false;
    preparedResizeAnchor = anchor;
    preparedResizeUntil = Date.now() + PREPARED_RESIZE_TTL;
    guardLocation(anchor.cfi);
    return true;
  }

  function takePreparedResizeAnchor() {
    if (!preparedResizeAnchor || Date.now() > preparedResizeUntil) {
      preparedResizeAnchor = null;
      preparedResizeUntil = 0;
      return null;
    }
    const anchor = preparedResizeAnchor;
    preparedResizeAnchor = null;
    preparedResizeUntil = 0;
    return anchor;
  }

  function resize(width, height) {
    // EPUB.js clears the manager during resize. Before the first relocated
    // event there is no CFI to redisplay, so resizing during startup would
    // leave an empty container.
    if (!rendition || phase !== 'ready') return false;
    const size = measuredSize(width, height);
    if (size.width < 1 || size.height < 1) return false;
    if (Math.abs(size.width - requestedWidth) < 1 && Math.abs(size.height - requestedHeight) < 1) return false;
    const anchor = resizeAnchor
      || takePreparedResizeAnchor()
      || captureResizeAnchor(lastLocation?.cfi || currentCfi(rendition));
    if (!anchor) return false;
    guardLocation(anchor.cfi);
    requestedWidth = size.width;
    requestedHeight = size.height;
    resizeAnchor = anchor;
    pendingResize = { ...size, anchor };
    resizeStableFrames = 0;
    scheduleResize();
    return true;
  }

  function scheduleResize() {
    // Wait for the host size to settle before asking EPUB.js to resize. A
    // sidebar transition publishes an intermediate width on every frame, and
    // EPUB.js destroys/rebuilds its views for each resize. Trailing coalescing
    // keeps the first reading anchor but commits only the final dimensions.
    if (resizeFrame !== null || resizeTask || settingsMutating || navigationMutating || !pendingResize) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (resizeTask || settingsMutating || navigationMutating || !pendingResize) return;
      const measured = measuredSize();
      if (measured.width < 1 || measured.height < 1) {
        requestedWidth = lastWidth;
        requestedHeight = lastHeight;
        pendingResize = null;
        resizeAnchor = null;
        resizeStableFrames = 0;
        return;
      }
      if (Math.abs(measured.width - pendingResize.width) >= 1
        || Math.abs(measured.height - pendingResize.height) >= 1) {
        requestedWidth = measured.width;
        requestedHeight = measured.height;
        pendingResize = { ...measured, anchor: resizeAnchor || pendingResize.anchor };
        resizeStableFrames = 0;
        scheduleResize();
        return;
      }
      resizeStableFrames += 1;
      if (resizeStableFrames <= RESIZE_SETTLE_FRAMES) {
        scheduleResize();
        return;
      }
      const request = pendingResize;
      pendingResize = null;
      resizeStableFrames = 0;
      const task = (async () => {
        if (phase !== 'ready' || !rendition) return;
        const { width, height, anchor } = request;
        const releaseLocations = suppressLocations();
        dom.frameHost.classList.add('epub-reflowing');
        try {
          await resizeAndWaitForSection(rendition, width, height, anchor.cfi);
          if (phase !== 'ready' || !rendition) return;
          updateTheme();
          await waitForRenditionLayout(rendition);
          await alignCapturedAnchor(anchor, 6);
          await reportAlignedLocation();
          await alignCapturedAnchor(anchor);
          dom.frameHost.classList.remove('epub-reflowing');
          releaseLocations();
          await reportAlignedLocation();
          lastWidth = width;
          lastHeight = height;
        } finally {
          dom.frameHost.classList.remove('epub-reflowing');
          releaseLocations();
        }
      })().catch((error) => {
        requestedWidth = lastWidth;
        requestedHeight = lastHeight;
        emitError(error, false);
      });
      resizeTask = task;
      task.finally(() => {
        if (resizeTask === task) resizeTask = null;
        if (pendingResize) scheduleResize();
        else resizeAnchor = null;
      });
    });
  }

  async function waitForResizeIdle() {
    const startedAt = Date.now();
    while (phase === 'ready') {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 4000) {
        throw new Error(`EPUB resize queue did not settle (task=${Boolean(resizeTask)}, frame=${resizeFrame !== null}, pending=${Boolean(pendingResize)}, settings=${settingsMutating}).`);
      }
      const activeTask = resizeTask;
      if (activeTask) {
        await Promise.race([
          activeTask,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('EPUB resize operation timed out.')),
            Math.max(1, 4000 - elapsed),
          )),
        ]);
        continue;
      }
      if (resizeFrame !== null || pendingResize) {
        await nextAnimationFrame();
        continue;
      }

      // Give ResizeObserver one paint to publish a final transition size.
      await nextAnimationFrame();
      if (!resizeTask && resizeFrame === null && !pendingResize) return;
    }
  }

  async function waitForReaderIdle() {
    const startedAt = Date.now();
    while (phase === 'ready') {
      if (Date.now() - startedAt > 5000) {
        throw new Error('EPUB reader operation queue did not settle.');
      }
      if (navigationMutating) {
        await nextAnimationFrame();
        continue;
      }
      const activeSettings = settingsTask;
      if (activeSettings) {
        await activeSettings;
        continue;
      }
      await waitForResizeIdle();
      if (!settingsTask && !resizeTask && resizeFrame === null && !pendingResize) return;
    }
  }

  function textPointFromRange(doc, sourceRange, preferredTop) {
    const node = sourceRange?.startContainer;
    if (!node || node.nodeType !== 3 || !node.data?.length) return null;
    const baseOffset = Math.min(node.data.length, Math.max(0, sourceRange.startOffset));
    let best = null;

    // caretRangeFromPoint can land immediately before whitespace. Normalize to
    // the closest rendered character so the saved CFI always has a glyph whose
    // viewport position can be measured again after EPUB.js rebuilds the iframe.
    for (let distance = 0; distance <= 48; distance += 1) {
      const offsets = distance === 0
        ? [baseOffset]
        : [baseOffset + distance, baseOffset - distance];
      for (const offset of offsets) {
        if (offset < 0 || offset >= node.data.length || /\s/.test(node.data[offset])) continue;
        const codePoint = node.data.codePointAt(offset);
        const probeLength = codePoint > 0xffff ? 2 : 1;
        if (offset + probeLength > node.data.length) continue;
        const probe = doc.createRange();
        probe.setStart(node, offset);
        probe.setEnd(node, offset + probeLength);
        const rect = [...probe.getClientRects()].find((candidate) => candidate.height > 0);
        if (!rect) continue;
        const score = Math.abs(rect.top - preferredTop);
        if (!best || score < best.score) {
          const caret = doc.createRange();
          caret.setStart(node, offset);
          caret.collapse(true);
          best = {
            caret,
            rect,
            probeLength,
            score,
            exact: node.data.slice(offset, offset + probeLength),
            prefix: node.data.slice(Math.max(0, offset - 20), offset),
            suffix: node.data.slice(offset + probeLength, offset + probeLength + 20),
          };
        }
      }
      if (best && best.score <= 1) break;
    }
    return best;
  }

  function caretRangeAtPoint(doc, x, y) {
    if (typeof doc.caretRangeFromPoint === 'function') return doc.caretRangeFromPoint(x, y);
    if (typeof doc.caretPositionFromPoint !== 'function') return null;
    const position = doc.caretPositionFromPoint(x, y);
    if (!position?.offsetNode) return null;
    const range = doc.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }

  function captureVisibleTextAnchor() {
    const manager = rendition?.manager;
    const container = manager?.container;
    const views = manager?.views?.displayed?.() || manager?.views?.all?.() || [];
    if (!container || !views.length) return null;

    const containerRect = container.getBoundingClientRect();
    if (containerRect.width < 1 || containerRect.height < 1) return null;
    const targetTop = containerRect.top + Math.min(
      TEXT_ANCHOR_MAX_OFFSET,
      Math.max(48, containerRect.height * TEXT_ANCHOR_VIEWPORT_RATIO),
    );
    let best = null;

    for (const view of views) {
      const iframe = view?.iframe;
      const doc = view?.contents?.document;
      const body = view?.contents?.content || doc?.body;
      if (!iframe || !doc || !body || typeof view.contents?.cfiFromRange !== 'function') continue;
      const iframeRect = iframe.getBoundingClientRect();
      const visibleTop = Math.max(iframeRect.top, containerRect.top);
      const visibleBottom = Math.min(iframeRect.bottom, containerRect.bottom);
      if (visibleBottom - visibleTop < 2) continue;
      const innerHeight = view.contents?.window?.innerHeight || iframeRect.height;
      const scaleY = iframeRect.height > 0 && innerHeight > 0 ? iframeRect.height / innerHeight : 1;
      const walker = doc.createTreeWalker(body, doc.defaultView.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.data?.trim()) return doc.defaultView.NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('style, script, title, noscript, svg')) {
            return doc.defaultView.NodeFilter.FILTER_REJECT;
          }
          return doc.defaultView.NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          const globalTop = iframeRect.top + rect.top * scaleY;
          const globalBottom = iframeRect.top + rect.bottom * scaleY;
          if (globalBottom <= containerRect.top + 1 || globalTop >= containerRect.bottom - 1) continue;
          const partiallyClipped = globalTop < containerRect.top + 2
            || globalBottom > containerRect.bottom - 2;
          const score = Math.abs((globalTop + globalBottom) / 2 - targetTop)
            + (partiallyClipped ? containerRect.height : 0);
          if (!best || score < best.score) {
            best = { view, doc, iframeRect, rect, scaleY, score };
          }
        }
      }
    }

    if (!best) return null;
    const xCandidates = [
      best.rect.left + best.rect.width / 2,
      best.rect.left + Math.min(4, best.rect.width / 3),
      best.rect.right - Math.min(4, best.rect.width / 3),
    ];
    const localY = best.rect.top + best.rect.height / 2;
    let point = null;
    for (const localX of xCandidates) {
      const sourceRange = caretRangeAtPoint(best.doc, localX, localY);
      const candidate = textPointFromRange(best.doc, sourceRange, best.rect.top);
      if (!candidate) continue;
      if (!point || candidate.score < point.score) point = candidate;
    }
    if (!point || point.score > Math.max(4, best.rect.height)) return null;

    try {
      const cfi = best.view.contents.cfiFromRange(point.caret, best.view.settings?.ignoreClass);
      const globalTop = best.iframeRect.top + point.rect.top * best.scaleY;
      return {
        kind: 'text',
        cfi,
        target: cfi,
        viewportOffset: globalTop - containerRect.top,
        probeLength: point.probeLength,
        quote: {
          exact: point.exact,
          prefix: point.prefix,
          suffix: point.suffix,
        },
      };
    } catch {
      return null;
    }
  }

  function captureResizeAnchor(cfi) {
    const textAnchor = captureVisibleTextAnchor();
    if (textAnchor) return textAnchor;
    if (!cfi) return null;
    const anchor = { kind: 'location', cfi, target: cfi, viewportOffset: null };
    const manager = rendition?.manager;
    const container = manager?.container;
    const section = book?.spine?.get(cfi);
    const view = section && manager?.views?.find?.(section);
    if (!container || !view?.element || typeof view.locationOf !== 'function') return anchor;

    try {
      const location = view.locationOf(cfi);
      const containerRect = container.getBoundingClientRect();
      const viewRect = view.element.getBoundingClientRect();
      const offset = viewRect.top - containerRect.top + location.top;
      if (Number.isFinite(offset)) anchor.viewportOffset = offset;
    } catch {
      // The CFI remains a valid fallback if its view is between render cycles.
    }
    return anchor;
  }

  function measureTextAnchor(anchor) {
    const manager = rendition?.manager;
    const container = manager?.container;
    const section = book?.spine?.get(anchor?.cfi);
    const view = section && manager?.views?.find?.(section);
    if (!container || !view?.iframe || typeof view.contents?.range !== 'function') return null;

    try {
      const range = view.contents.range(anchor.cfi, view.settings?.ignoreClass);
      const node = range?.startContainer;
      const offset = range?.startOffset;
      if (!node || node.nodeType !== 3 || !Number.isFinite(offset) || offset >= node.data.length) return null;
      const probeLength = Math.max(1, Math.min(anchor.probeLength || 1, node.data.length - offset));
      if (anchor.quote?.exact
        && node.data.slice(offset, offset + probeLength) !== anchor.quote.exact) return null;
      const probe = view.contents.document.createRange();
      probe.setStart(node, offset);
      probe.setEnd(node, offset + probeLength);
      const rect = [...probe.getClientRects()].find((candidate) => candidate.height > 0);
      if (!rect) return null;
      const iframeRect = view.iframe.getBoundingClientRect();
      const innerHeight = view.contents?.window?.innerHeight || iframeRect.height;
      const scaleY = iframeRect.height > 0 && innerHeight > 0 ? iframeRect.height / innerHeight : 1;
      const containerRect = container.getBoundingClientRect();
      return {
        manager,
        container,
        viewportOffset: iframeRect.top + rect.top * scaleY - containerRect.top,
      };
    } catch {
      return null;
    }
  }

  function renditionGeometrySignature() {
    const manager = rendition?.manager;
    const views = manager?.views?.all?.() || [];
    return views.map((view) => {
      const elementHeight = view?.element?.getBoundingClientRect?.().height || 0;
      const iframeHeight = view?.iframe?.getBoundingClientRect?.().height || 0;
      return `${view?.section?.index ?? '?'}:${view?.displayed ? 1 : 0}:${elementHeight.toFixed(2)}:${iframeHeight.toFixed(2)}`;
    }).join('|');
  }

  async function alignCapturedAnchor(anchor, stableFramesRequired = 2) {
    if (anchor?.kind === 'text' && Number.isFinite(anchor.viewportOffset)) {
      let measured = false;
      let previousGeometry = '';
      let stableFrames = 0;
      for (let frame = 0; frame < 30; frame += 1) {
        const current = measureTextAnchor(anchor);
        if (!current) break;
        measured = true;
        const delta = current.viewportOffset - anchor.viewportOffset;
        if (Math.abs(delta) > 0.5) {
          current.manager.scrollTo(
            current.container.scrollLeft,
            Math.max(0, current.container.scrollTop + delta),
            false,
          );
          stableFrames = 0;
        }
        await nextAnimationFrame();
        const geometry = renditionGeometrySignature();
        const managerQueue = rendition?.manager?.q;
        const renditionQueue = rendition?.q;
        const queueBusy = Boolean(managerQueue?.running)
          || Boolean(managerQueue?.length?.())
          || Boolean(renditionQueue?.running)
          || Boolean(renditionQueue?.length?.());
        if (Math.abs(delta) <= 0.5 && geometry && geometry === previousGeometry && !queueBusy) {
          stableFrames += 1;
          if (stableFrames >= stableFramesRequired) return true;
        } else {
          stableFrames = 0;
        }
        previousGeometry = geometry;
      }
      if (measured) return true;
    }

    const section = book?.spine?.get(anchor?.cfi);
    return section
      ? alignTargetInContinuousView(section, anchor.target, anchor.viewportOffset)
      : false;
  }

  function alignTargetInContinuousView(section, target, viewportOffset = 0) {
    const manager = rendition?.manager;
    const container = manager?.container;
    const view = manager?.views?.find?.(section);
    if (!container || !view?.element || typeof manager.scrollTo !== 'function') return false;

    const containerRect = container.getBoundingClientRect();
    const viewRect = view.element.getBoundingClientRect();
    let targetOffset = 0;
    if (target && target !== section.href && typeof view.locationOf === 'function') {
      try {
        const location = view.locationOf(target);
        if (Number.isFinite(location?.top)) targetOffset = location.top;
      } catch {
        // A chapter-level target still has a valid view anchor.
      }
    }
    // Nudge past the preceding view's fractional-pixel boundary so EPUB.js
    // reports the selected chapter as the visible start, not the prior one.
    const preservedOffset = Number.isFinite(viewportOffset) ? viewportOffset : 0;
    const top = container.scrollTop + viewRect.top - containerRect.top + targetOffset - preservedOffset + 2;
    manager.scrollTo(0, Math.max(0, top), false);
    return true;
  }

  async function reportAlignedLocation() {
    await nextAnimationFrame();
    await rendition.reportLocation();
    // EPUB.js schedules the actual location calculation in its own rAF.
    await nextAnimationFrame();
  }

  async function display(target) {
    await ready;
    assertUsable();
    await waitForReaderIdle();
    const section = book.spine.get(target);
    navigationMutating = true;
    guardLocation(target);
    const releaseLocations = suppressLocations();
    try {
      await rendition.display(target);
      if (section) alignTargetInContinuousView(section, target);
      await reportAlignedLocation();
      if (section) alignTargetInContinuousView(section, target);
      releaseLocations();
      await reportAlignedLocation();
      return getCurrentLocation();
    } finally {
      releaseLocations();
      navigationMutating = false;
      if (pendingResize) scheduleResize();
    }
  }

  async function goChapter(directionOrHref) {
    await ready;
    assertUsable();
    await waitForReaderIdle();

    if (directionOrHref !== 'next' && directionOrHref !== 'prev' && directionOrHref !== 'previous') {
      return display(directionOrHref);
    }

    const current = lastLocation?.location || rendition.currentLocation();
    const start = current && typeof current.then === 'function' ? (await current)?.start : current?.start;
    const section = book.spine.get(start?.index ?? start?.href ?? start?.cfi);
    const destination = directionOrHref === 'next' ? section?.next?.() : section?.prev?.();
    if (!destination) return false;
    navigationMutating = true;
    guardLocation(destination.href);
    const releaseLocations = suppressLocations();
    try {
      await rendition.display(destination.href);
      alignTargetInContinuousView(destination, destination.href);
      await reportAlignedLocation();
      alignTargetInContinuousView(destination, destination.href);
      releaseLocations();
      await reportAlignedLocation();
      return getCurrentLocation() || true;
    } finally {
      releaseLocations();
      navigationMutating = false;
      if (pendingResize) scheduleResize();
    }
  }

  function getCurrentLocation() {
    if (lastLocation) return { ...lastLocation };
    if (!rendition || phase !== 'ready') return null;
    try {
      const value = rendition.currentLocation();
      return value && typeof value.then !== 'function' ? locationPayload(value) : null;
    } catch {
      return null;
    }
  }

  function settleSettingsWaiters(version, error) {
    for (let index = settingsWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = settingsWaiters[index];
      if (waiter.version > version && !error) continue;
      settingsWaiters.splice(index, 1);
      if (error) waiter.reject(error);
      else waiter.resolve(settings);
    }
  }

  function runSettingsTask() {
    if (settingsTask || !rendition || phase !== 'ready') return;
    settingsTask = (async () => {
      let appliedVersion = 0;
      while (phase === 'ready' && appliedVersion < settingsVersion) {
        const targetVersion = settingsVersion;
        await waitForResizeIdle();
        const anchor = settingsAnchor || captureResizeAnchor(lastLocation?.cfi || currentCfi(rendition));
        if (anchor) guardLocation(anchor.cfi);
        settingsMutating = true;
        try {
          await waitForRenditionLayout(rendition);
          if (targetVersion !== settingsVersion) continue;
          if (anchor) await alignCapturedAnchor(anchor, 4);
          await reportAlignedLocation();
          if (anchor) await alignCapturedAnchor(anchor);
          await reportAlignedLocation();
        } finally {
          settingsMutating = false;
          if (pendingResize) scheduleResize();
        }
        appliedVersion = targetVersion;
        settingsAnchor = null;
        settleSettingsWaiters(appliedVersion);
      }
    })().catch((error) => {
      const reported = emitError(error, false);
      settleSettingsWaiters(Infinity, reported);
    }).finally(() => {
      settingsTask = null;
      if (phase === 'ready' && settingsWaiters.length) runSettingsTask();
      if (phase === 'ready' && pendingResize) scheduleResize();
    });
  }

  function applySettings(input = {}) {
    assertUsable();
    if (phase === 'ready' && !settingsAnchor) {
      settingsAnchor = captureResizeAnchor(lastLocation?.cfi || currentCfi(rendition));
    }
    settings = mergeSettings(settings, input);
    settingsVersion += 1;
    updateTheme();

    if (phase !== 'ready') return Promise.resolve(settings);
    const result = new Promise((resolve, reject) => {
      settingsWaiters.push({ version: settingsVersion, resolve, reject });
    });
    runSettingsTask();
    return result;
  }

  function attach(nextParent = parent) {
    assertUsable();
    if (!nextParent || typeof nextParent.appendChild !== 'function') {
      throw new TypeError('attach requires a parent DOM element.');
    }
    nextParent.appendChild(dom.root);
    requestAnimationFrame(() => resize());
    return controller;
  }

  function detach() {
    if (dom.root.parentNode) dom.root.remove();
    return controller;
  }

  function releaseBook() {
    const closingBook = book;
    const closingRendition = rendition;
    book = null;
    rendition = null;
    // EPUB.js leaves navigation/display-option/resource work running after
    // open(). Destroying sooner clears `loading` under those callbacks. Keep
    // only the captured library objects alive until that work has settled.
    void bookOpenSettled.then(() => {
      try {
        if (closingBook) closingBook.destroy();
        else if (closingRendition) closingRendition.destroy();
      } catch {
        // Partial or malformed EPUB.js books may not fully destroy.
      }
    });
  }

  function destroy() {
    if (phase === 'destroyed') return;
    const wasLoading = phase === 'loading';
    phase = 'destroyed';
    settingsVersion += 1;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    resizeFrame = null;
    pendingResize = null;
    resizeAnchor = null;
    preparedResizeAnchor = null;
    preparedResizeUntil = 0;
    resizeStableFrames = 0;
    locationSuppressionCount = 0;
    navigationMutating = false;
    guardedLocationIndex = null;
    guardedLocationUntil = 0;
    settingsAnchor = null;
    settingsMutating = false;
    resizeObserver?.disconnect();
    resizeObserver = null;

    if (rendition && relocatedHandler) rendition.off('relocated', relocatedHandler);
    if (rendition && renderedHandler) rendition.off('rendered', renderedHandler);
    if (rendition && contentHook) rendition.hooks.content.deregister(contentHook);
    settleSettingsWaiters(Infinity, new EpubViewError('EPUB_DESTROYED', 'The EPUB reader has been destroyed.'));

    releaseBook();
    dom.root.remove();
    dom.root.replaceChildren();
    if (wasLoading) rejectReady(new EpubViewError('EPUB_DESTROYED', 'The EPUB reader was closed while loading.'));
  }

  const controller = {
    dom: dom.root,
    element: dom.root,
    ready,
    get state() { return phase; },
    get toc() { return toc; },
    get metadata() { return metadata; },
    attach,
    detach,
    prepareResize,
    resize,
    display,
    goChapter,
    applySettings,
    getCurrentLocation,
    destroy,
  };

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(dom.root);
  }

  (async () => {
    try {
      const buffer = toArrayBuffer(data);
      if (phase === 'destroyed') return;
      // ArrayBuffer input must be auto-detected as "binary". Forcing `openAs:
      // "epub"` makes EPUB.js treat the buffer as a URL and request it.
      book = ePub();
      const opened = book.opened;
      const loaded = book.ready;
      // Observe open() itself: for a malformed archive it rejects while
      // EPUB.js's opened/ready promises can remain pending forever. Only a
      // successful open attempt should wait for those remaining load tasks.
      const opening = book.open(buffer).then(() => Promise.all([opened, loaded]));
      bookOpenSettled = opening.then(() => {}, () => {});
      await opening;
      if (phase === 'destroyed') return;

      const [loadedMetadata, spine, navigation, displayOptions] = await Promise.all([
        book.loaded.metadata,
        book.loaded.spine,
        book.loaded.navigation,
        book.loaded.displayOptions,
      ]);
      if (phase === 'destroyed') return;
      if (isFixedLayout(loadedMetadata, spine, displayOptions)) {
        throw new EpubViewError('EPUB_FIXED_LAYOUT', 'Fixed-layout EPUBs are not supported.');
      }
      if (await hasUnsupportedEncryption(book)) {
        throw new EpubViewError('EPUB_DRM', 'Unsupported EPUB encryption detected.');
      }
      if (phase === 'destroyed') return;

      metadata = { ...loadedMetadata };
      toc = copyToc(navigation?.toc || []);
      flatToc = flattenToc(toc);
      safeCallback(callbacks.onToc, toc);

      const renderSize = measuredSize();
      rendition = book.renderTo(dom.frameHost, {
        manager: 'continuous',
        flow: 'scrolled-doc',
        spread: 'none',
        // Numeric dimensions prevent EPUB.js from also subscribing to the
        // window resize event. Moth's ResizeObserver is the single owner of
        // resizing, so an external resize cannot turn our operation into an
        // event-less no-op while it waits for `rendered`.
        width: Math.max(1, renderSize.width),
        height: Math.max(1, renderSize.height),
        allowScriptedContent: false,
      });
      rendition.spread('none');
      contentHook = applyThemeToContents;
      rendition.hooks.content.register(contentHook);
      renderedHandler = (_section, view) => {
        if (view?.contents) applyThemeToContents(view.contents);
      };
      rendition.on('rendered', renderedHandler);
      relocatedHandler = (location) => emitLocation(location);
      rendition.on('relocated', relocatedHandler);
      updateTheme();

      let initialTarget = options.initialCfi || undefined;
      try {
        await displayInitialSection(rendition, initialTarget);
      } catch (error) {
        if (!initialTarget) throw error;
        initialTarget = undefined;
        await displayInitialSection(rendition);
      }
      if (phase === 'destroyed') return;
      const initialSize = measuredSize();
      lastWidth = initialSize.width;
      lastHeight = initialSize.height;
      requestedWidth = initialSize.width;
      requestedHeight = initialSize.height;
      phase = 'ready';
      hideState(dom.state);
      safeCallback(callbacks.onReady, { metadata, toc });
      resolveReady(controller);

      safeCallback(callbacks.onProgress, {
        status: 'generating',
        percentage: lastLocation?.percentage ?? null,
        locations: 0,
        cfi: lastLocation?.cfi ?? null,
      });
      book.locations.generate(locationBreak).then((locations) => {
        if (phase === 'destroyed') return;
        locationsReady = true;
        locationCount = Array.isArray(locations) ? locations.length : book.locations.length();
        const percentage = lastLocation?.cfi ? percentageFor(lastLocation.cfi, lastLocation.location) : null;
        if (lastLocation) lastLocation.percentage = percentage;
        safeCallback(callbacks.onProgress, {
          status: 'ready',
          percentage,
          locations: locationCount,
          cfi: lastLocation?.cfi ?? null,
        });
        rendition.reportLocation();
      }).catch((error) => {
        if (phase === 'destroyed') return;
        safeCallback(callbacks.onProgress, {
          status: 'error',
          percentage: lastLocation?.percentage ?? null,
          locations: 0,
          cfi: lastLocation?.cfi ?? null,
        });
        emitError(error, false);
      });
    } catch (input) {
      if (phase === 'destroyed') return;
      const error = emitError(input, true);
      phase = 'error';
      showError(dom.state, error);
      releaseBook();
      rejectReady(error);
    }
  })();

  return controller;
}

function destroyEpubView(view) {
  view?.destroy?.();
}

module.exports = { createEpubView, destroyEpubView, EpubViewError };

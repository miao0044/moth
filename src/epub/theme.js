import { bundledFontFaces } from './fonts.js';

const DEFAULTS = Object.freeze({
  font: 'serif',
  fontSize: 16,
  padding: 50,
  spacing: 100,
  background: '#262626',
  text: '#cccccc',
  textBright: '#e0e0e0',
  textMuted: '#888888',
  accent: '#4fc1ff',
  border: '#333333',
  codeBackground: '#2f2f2f',
  selection: 'rgba(79, 193, 255, 0.2)',
  monospace: 'Consolas, "Courier New", monospace',
});

const COLOR_VARIABLES = Object.freeze({
  background: '--bg',
  text: '--text',
  textBright: '--text-bright',
  textMuted: '--text-muted',
  accent: '--accent',
  border: '--border',
});

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function safeCssFont(value) {
  if (typeof value !== 'string') return DEFAULTS.font;
  const sanitized = value.replace(/[\u0000-\u001f{};]/g, '').trim();
  return sanitized || DEFAULTS.font;
}

function validColor(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', value.trim())) {
    return fallback;
  }
  return value.trim();
}

function rootColor(name, fallback) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return validColor(value, fallback);
}

export function normalizeSettings(input = {}) {
  const resolvedColors = {};
  for (const [key, variable] of Object.entries(COLOR_VARIABLES)) {
    resolvedColors[key] = rootColor(variable, DEFAULTS[key]);
  }

  return Object.freeze({
    font: safeCssFont(input.font ?? DEFAULTS.font),
    fontSize: finiteNumber(input.fontSize, DEFAULTS.fontSize, 8, 72),
    padding: finiteNumber(input.padding, DEFAULTS.padding, 0, 400),
    spacing: finiteNumber(input.spacing, DEFAULTS.spacing, 50, 250),
    background: validColor(input.background, resolvedColors.background),
    text: validColor(input.text, resolvedColors.text),
    textBright: validColor(input.textBright, resolvedColors.textBright),
    textMuted: validColor(input.textMuted, resolvedColors.textMuted),
    accent: validColor(input.accent, resolvedColors.accent),
    border: validColor(input.border, resolvedColors.border),
    codeBackground: validColor(input.codeBackground, DEFAULTS.codeBackground),
    selection: validColor(input.selection, DEFAULTS.selection),
    monospace: safeCssFont(input.monospace ?? DEFAULTS.monospace),
  });
}

export function mergeSettings(previous, input = {}) {
  return normalizeSettings({ ...previous, ...input });
}

export function buildThemeCss(settings) {
  const lineHeight = 1.7 * (settings.spacing / 100);
  const paragraphSpacing = settings.spacing / 100;

  return `
    ${bundledFontFaces}

    :root {
      color-scheme: dark !important;
      background: ${settings.background} !important;
    }

    html, body {
      min-width: 0 !important;
      max-width: none !important;
      background: ${settings.background} !important;
      color: ${settings.text} !important;
    }

    body {
      box-sizing: border-box !important;
      width: auto !important;
      margin: 0 !important;
      padding: 30px ${settings.padding}px 64px !important;
      overflow-wrap: anywhere;
      font-family: ${settings.font} !important;
      font-size: ${settings.fontSize}px !important;
      line-height: ${lineHeight} !important;
    }

    body, body * {
      font-family: ${settings.font} !important;
    }

    pre, code, pre *, code *, kbd, samp {
      font-family: ${settings.monospace} !important;
    }

    p { margin: ${paragraphSpacing}em 0 !important; }
    ul, ol { margin: ${0.8 * paragraphSpacing}em 0 !important; padding-left: 2em !important; }
    li { margin: ${0.4 * paragraphSpacing}em 0 !important; }
    li > ul, li > ol { margin: ${0.15 * paragraphSpacing}em 0 !important; }

    h1, h2, h3, h4, h5, h6 {
      color: ${settings.textBright} !important;
      font-weight: 600 !important;
      line-height: 1.3 !important;
      margin: 1.4em 0 0.6em !important;
    }
    h1 { font-size: 1.8em !important; border-bottom: 1px solid ${settings.border} !important; padding-bottom: 0.3em !important; }
    h2 { font-size: 1.5em !important; border-bottom: 1px solid ${settings.border} !important; padding-bottom: 0.3em !important; }
    h3 { font-size: 1.25em !important; }
    h4 { font-size: 1.1em !important; }
    h5 { font-size: 1.05em !important; }
    h6 { font-size: 1em !important; }

    a, a:visited { color: ${settings.accent} !important; text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong, b { color: ${settings.textBright}; }

    blockquote {
      box-sizing: border-box;
      margin: 1em 0 !important;
      padding: 0.5em 1em !important;
      border-left: 3px solid ${settings.textMuted} !important;
      background: rgba(255, 255, 255, 0.03) !important;
      color: ${settings.textMuted} !important;
    }

    code {
      border-radius: 3px;
      background: ${settings.codeBackground} !important;
      padding: 2px 6px;
      font-size: 0.9em;
    }
    pre {
      box-sizing: border-box;
      max-width: 100%;
      margin: 1em 0 !important;
      padding: 16px !important;
      overflow: auto;
      border-radius: 6px;
      background: ${settings.codeBackground} !important;
      white-space: pre-wrap;
      overflow-wrap: break-word;
    }
    pre code { padding: 0 !important; background: none !important; font-size: 0.875em; }

    table { width: 100%; margin: 1em 0 !important; border-collapse: collapse; }
    th, td { padding: 8px 12px !important; border: 1px solid ${settings.border} !important; text-align: start; }
    th { background: ${settings.codeBackground} !important; color: ${settings.textBright} !important; }
    tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }

    hr { margin: 2em 0 !important; border: 0 !important; border-top: 1px solid ${settings.border} !important; }
    img, svg, video, canvas { max-width: 100% !important; height: auto; }
    img { border-radius: 4px; }
    iframe { max-width: 100%; }

    ::selection { background: ${settings.selection}; }
  `;
}

const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'META', 'TITLE', 'BASE', 'NOSCRIPT']);

// Stylesheet rules cannot beat a publisher's inline `font-family: ... !important`.
// Applying the final declaration directly is deliberate: it makes the Moth font
// authoritative while leaving weight, emphasis, and all non-font layout intact.
export function enforceFont(contents, settings) {
  const doc = contents?.document;
  const body = contents?.content || doc?.body;
  if (!doc || !body) return;

  const elements = [body, ...body.querySelectorAll('*')];
  for (const element of elements) {
    if (!element?.style || SKIP_TAGS.has(element.tagName) || element.closest?.('svg')) continue;
    const isCode = element.matches?.('pre, code, kbd, samp') || element.closest?.('pre, code');
    element.style.setProperty(
      'font-family',
      isCode ? settings.monospace : settings.font,
      'important',
    );
  }
}

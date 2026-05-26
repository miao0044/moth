import { EditorView } from '@codemirror/view';

export const mothTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--md-font, serif)',
    fontSize: 'var(--md-font-size, 16px)',
    lineHeight: 'calc(1.7 * var(--md-spacing, 1))',
  },
  '.cm-content': {
    padding: '30px var(--content-padding, 50px)',
    caretColor: 'var(--accent)',
    maxWidth: '100%',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(79, 193, 255, 0.2) !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-line': {
    padding: '0',
  },

  // Heading styles
  '.cm-heading-1': { fontSize: '1.8em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },
  '.cm-heading-2': { fontSize: '1.5em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },
  '.cm-heading-3': { fontSize: '1.25em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },
  '.cm-heading-4': { fontSize: '1.1em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },
  '.cm-heading-5': { fontSize: '1.05em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },
  '.cm-heading-6': { fontSize: '1em', fontWeight: '600', color: 'var(--text-bright)', lineHeight: '1.3' },

  // Inline styles
  '.cm-strong': { fontWeight: 'bold', color: 'var(--text-bright)' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through' },
  '.cm-inline-code': {
    backgroundColor: '#2f2f2f',
    padding: '2px 6px',
    borderRadius: '3px',
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: '0.9em',
  },
  '.cm-link-text': { color: 'var(--accent)' },
  '.cm-url': { color: 'var(--text-muted)', fontSize: '0.9em' },

  // Block styles
  '.cm-blockquote-line': {
    borderLeft: '3px solid #555',
    paddingLeft: '1em',
    color: 'var(--text-muted)',
  },
  '.cm-codeblock': {
    backgroundColor: '#2f2f2f',
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: '0.875em',
    borderRadius: '0',
  },
  '.cm-codeblock-first': { borderRadius: '6px 6px 0 0', paddingTop: '8px' },
  '.cm-codeblock-last': { borderRadius: '0 0 6px 6px', paddingBottom: '8px' },
  '.cm-codeblock-only': { borderRadius: '6px', paddingTop: '8px', paddingBottom: '8px' },
  '.cm-hr-widget': {
    borderTop: '1px solid var(--border)',
    margin: '2em 0',
    display: 'block',
  },

  // Syntax marks (dimmed when visible on cursor line)
  '.cm-syntax-mark': { color: 'var(--text-muted)', opacity: '0.5' },

  // Search panel
  '.cm-panels': {
    backgroundColor: 'var(--bg-sidebar)',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text)',
  },
  '.cm-search': {
    fontFamily: '-apple-system, "Segoe UI", sans-serif',
    fontSize: '13px',
    padding: '6px 10px',
    gap: '4px',
  },
  '.cm-search label': {
    color: 'var(--text-muted)',
    fontSize: '13px',
  },
  '.cm-search input, .cm-search select': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '3px 8px',
    fontSize: '13px',
    outline: 'none',
  },
  '.cm-search input:focus': {
    borderColor: 'var(--accent)',
  },
  '.cm-search button': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  '.cm-search button:hover': {
    backgroundColor: 'var(--bg-hover)',
    color: 'var(--text-bright)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(255, 200, 50, 0.3)',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'rgba(255, 200, 50, 0.6)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(79, 193, 255, 0.15)',
  },
}, { dark: true });

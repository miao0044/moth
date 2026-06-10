import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { languages } from '@codemirror/language-data';
import { mothTheme } from './theme.js';
import { livePreviewPlugin } from './live-preview.js';

const MARKDOWN_EXTS = ['.md', '.markdown', '.txt', ''];

function createEditorView(parent, content, { onChange, fileExt = '' }) {
  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged) {
      onChange(update.state.doc.toString());
    }
  });

  const isMarkdown = MARKDOWN_EXTS.includes(fileExt.toLowerCase());

  const langExtension = isMarkdown
    ? markdown({ base: markdownLanguage, codeLanguages: languages })
    : json();

  const extensions = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    search(),
    highlightSelectionMatches(),
    langExtension,
    mothTheme,
    updateListener,
  ];

  if (isMarkdown) extensions.push(livePreviewPlugin);

  const state = EditorState.create({ doc: content, extensions });

  return new EditorView({ state, parent });
}

function destroyEditorView(view) {
  view.destroy();
}

function openSearch(view) {
  openSearchPanel(view);
}

module.exports = { createEditorView, destroyEditorView, openSearch };

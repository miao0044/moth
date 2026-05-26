import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { mothTheme } from './theme.js';
import { livePreviewPlugin } from './live-preview.js';

function createEditorView(parent, content, { onChange }) {
  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged) {
      onChange(update.state.doc.toString());
    }
  });

  const state = EditorState.create({
    doc: content,
    extensions: [
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
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      mothTheme,
      livePreviewPlugin,
      updateListener,
    ],
  });

  return new EditorView({ state, parent });
}

function destroyEditorView(view) {
  view.destroy();
}

function openSearch(view) {
  openSearchPanel(view);
}

module.exports = { createEditorView, destroyEditorView, openSearch };

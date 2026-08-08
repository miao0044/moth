import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { StreamLanguage, language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { json as legacyJson } from '@codemirror/legacy-modes/mode/javascript';
import { mothTheme } from './theme.js';
import { livePreviewPlugin } from './live-preview.js';

const MARKDOWN_EXTS = ['.md', '.markdown', '.txt', ''];

function createJsonLineState(indentUnit) {
  return {
    indentUnit,
    inner: legacyJson.startState(indentUnit),
  };
}

function copyLegacyState(state) {
  const copy = {};
  for (const key in state) {
    const value = state[key];
    copy[key] = Array.isArray(value) ? value.slice() : value;
  }
  return copy;
}

const jsonLinesLanguage = StreamLanguage.define({
  name: 'jsonl',
  startState: createJsonLineState,
  copyState(state) {
    return {
      indentUnit: state.indentUnit,
      inner: copyLegacyState(state.inner),
    };
  },
  token(stream, state) {
    if (stream.sol()) {
      state.inner = legacyJson.startState(state.indentUnit);
    }
    return legacyJson.token(stream, state.inner);
  },
  blankLine(state) {
    state.inner = legacyJson.startState(state.indentUnit);
  },
  languageData: legacyJson.languageData,
});

function createEditorView(parent, content, { onChange, fileExt = '' }) {
  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged) {
      onChange(update.state.doc.toString());
    }
  });

  const normalizedExt = fileExt.toLowerCase();
  const isMarkdown = MARKDOWN_EXTS.includes(normalizedExt);

  const langExtension = isMarkdown
    ? markdown({ base: markdownLanguage, codeLanguages: languages })
    : normalizedExt === '.jsonl'
      ? jsonLinesLanguage
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

function getEditorLanguageName(view) {
  return view?.state?.facet(language)?.name || null;
}

module.exports = { createEditorView, destroyEditorView, openSearch, getEditorLanguageName };

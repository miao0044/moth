import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-hr-widget';
    return hr;
  }
  eq() { return true; }
}

const headingClass = {
  1: 'cm-heading-1', 2: 'cm-heading-2', 3: 'cm-heading-3',
  4: 'cm-heading-4', 5: 'cm-heading-5', 6: 'cm-heading-6',
};

function getCursorLineRanges(state) {
  const ranges = [];
  for (const sel of state.selection.ranges) {
    const from = state.doc.lineAt(sel.from);
    const to = state.doc.lineAt(sel.to);
    for (let i = from.number; i <= to.number; i++) {
      const line = state.doc.line(i);
      ranges.push({ from: line.from, to: line.to });
    }
  }
  return ranges;
}

function onCursorLine(from, to, cursorLines) {
  for (const cl of cursorLines) {
    if (from <= cl.to && to >= cl.from) return true;
  }
  return false;
}

function hideSyntax(from, to, cursorLines, decos) {
  if (!onCursorLine(from, to, cursorLines)) {
    decos.push(Decoration.replace({}).range(from, to));
  } else {
    decos.push(Decoration.mark({ class: 'cm-syntax-mark' }).range(from, to));
  }
}

function buildDecorations(view) {
  const { state } = view;
  const cursorLines = getCursorLineRanges(state);
  const decos = [];
  const fencedRanges = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        const type = node.type.name;

        // --- ATX Headings ---
        const headingMatch = /^ATXHeading(\d)$/.exec(type);
        if (headingMatch) {
          const cls = headingClass[+headingMatch[1]];
          if (cls) decos.push(Decoration.mark({ class: cls }).range(node.from, node.to));
        }

        if (type === 'HeaderMark') {
          const line = state.doc.lineAt(node.from);
          const afterMark = Math.min(node.to + 1, line.to);
          if (!onCursorLine(node.from, node.to, cursorLines)) {
            decos.push(Decoration.replace({}).range(node.from, afterMark));
          } else {
            decos.push(Decoration.mark({ class: 'cm-syntax-mark' }).range(node.from, node.to));
          }
        }

        // --- Bold ---
        if (type === 'StrongEmphasis') {
          decos.push(Decoration.mark({ class: 'cm-strong' }).range(node.from, node.to));
        }

        // --- Italic ---
        if (type === 'Emphasis') {
          decos.push(Decoration.mark({ class: 'cm-em' }).range(node.from, node.to));
        }

        // --- Strikethrough ---
        if (type === 'Strikethrough') {
          decos.push(Decoration.mark({ class: 'cm-strikethrough' }).range(node.from, node.to));
        }

        // --- Emphasis marks (*, **, ~~) ---
        if (type === 'EmphasisMark' || type === 'StrikethroughMark') {
          hideSyntax(node.from, node.to, cursorLines, decos);
        }

        // --- Inline Code ---
        if (type === 'InlineCode') {
          decos.push(Decoration.mark({ class: 'cm-inline-code' }).range(node.from, node.to));
        }

        // --- CodeMark (backticks) — only for inline code, not fenced blocks ---
        if (type === 'CodeMark') {
          const inFenced = fencedRanges.some(r => node.from >= r.from && node.to <= r.to);
          if (!inFenced) {
            hideSyntax(node.from, node.to, cursorLines, decos);
          }
        }

        // --- Links: [text](url) ---
        if (type === 'Link') {
          const text = state.doc.sliceString(node.from, node.to);
          const closeBracket = text.indexOf(']');
          if (closeBracket > 0) {
            decos.push(Decoration.mark({ class: 'cm-link-text' }).range(node.from + 1, node.from + closeBracket));
            if (!onCursorLine(node.from, node.to, cursorLines)) {
              decos.push(Decoration.replace({}).range(node.from, node.from + 1));
              decos.push(Decoration.replace({}).range(node.from + closeBracket, node.to));
            }
          }
        }

        // --- Blockquote ---
        if (type === 'Blockquote') {
          const startLine = state.doc.lineAt(node.from);
          const endLine = state.doc.lineAt(node.to);
          for (let i = startLine.number; i <= endLine.number; i++) {
            const line = state.doc.line(i);
            if (line.length > 0) {
              decos.push(Decoration.line({ class: 'cm-blockquote-line' }).range(line.from));
            }
          }
        }

        if (type === 'QuoteMark') {
          const line = state.doc.lineAt(node.from);
          const endHide = Math.min(node.to + 1, line.to);
          if (!onCursorLine(node.from, node.to, cursorLines)) {
            decos.push(Decoration.replace({}).range(node.from, endHide));
          } else {
            decos.push(Decoration.mark({ class: 'cm-syntax-mark' }).range(node.from, node.to));
          }
        }

        // --- Fenced Code Blocks ---
        if (type === 'FencedCode') {
          fencedRanges.push({ from: node.from, to: node.to });
          const startLine = state.doc.lineAt(node.from);
          const endLine = state.doc.lineAt(node.to);

          for (let i = startLine.number; i <= endLine.number; i++) {
            const line = state.doc.line(i);
            const isFenceOpen = (i === startLine.number);
            const isFenceClose = (i === endLine.number);
            const isFence = isFenceOpen || isFenceClose;
            const cursorOnThis = onCursorLine(line.from, line.to, cursorLines);

            // Hide fence lines when cursor is away
            if (isFence && !cursorOnThis && line.length > 0) {
              decos.push(Decoration.replace({}).range(line.from, line.to));
            }
            if (isFence && cursorOnThis && line.length > 0) {
              decos.push(Decoration.mark({ class: 'cm-syntax-mark' }).range(line.from, line.to));
            }

            // Style code content lines
            if (!isFence) {
              decos.push(Decoration.line({ class: 'cm-codeblock' }).range(line.from));
            }
          }
        }

        // --- Horizontal Rule ---
        if (type === 'HorizontalRule') {
          if (!onCursorLine(node.from, node.to, cursorLines)) {
            decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
          }
        }
      }
    });
  }

  return Decoration.set(decos, true);
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: v => v.decorations }
);

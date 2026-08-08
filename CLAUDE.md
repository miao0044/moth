# Moth

Moth is a dark, minimal Windows editor and EPUB reader built with Electron, CodeMirror 6, and vanilla JavaScript. This file is project guidance for coding agents and should stay in the repository root.

## Architecture

Moth uses Electron's two-process model with no framework and no TypeScript.

- `main.js` — Electron main process: window lifecycle, single-instance handling, text/binary file I/O, rename IPC, and system dialogs
- `renderer.js` — renderer process: tabs, text editor and EPUB surface lifecycles, settings, sidebar, and keyboard shortcuts
- `index.html` / `style.css` — application shell and theming through CSS variables
- `src/editor/` — CodeMirror 6 editor source
  - `index.js` — exports `createEditorView`, `destroyEditorView`, and `openSearch`; selects Markdown, JSON, or JSONL language mode
  - `live-preview.js` — Obsidian-style Markdown live-preview decorations
  - `theme.js` — CodeMirror theme connected to application CSS variables
- `src/epub/` — EPUB.js reader surface, application typography override, TOC/progress/navigation, and resize/location handling
- `src/fonts/index.css` — local Lexend and Atkinson Hyperlegible font entry point
- `dist/` — generated editor, EPUB, and font bundles; never edit these files directly
- `scripts/qa-electron.cjs` — Electron integration regression suite
- `scripts/register-file-associations.ps1` — safe per-user Windows file association setup

Each tab owns a long-lived surface. Text tabs keep one CodeMirror `EditorView`; EPUB tabs keep one reader controller. Switching tabs detaches or hides the surface without recreating it so undo history, scroll position, selection, and reading position remain stable.

## Build, QA, and packaging

```powershell
npm ci
npm run build  # bundle src/editor, src/epub, and src/fonts into dist
npm run qa     # rebuild and run the Electron integration suite
npm start      # rebuild and run the development app
npm run dist   # regenerate icons, rebuild, and package release/win-unpacked/Moth.exe
```

The user runs the portable build at `release/win-unpacked/Moth.exe`, not the development process. After changing `main.js`, `renderer.js`, `index.html`, `style.css`, `src/editor/*`, `src/epub/*`, or `src/fonts/*`, run `npm run qa` and then `npm run dist`. Source edits alone are not visible in the portable app.

If `Moth.exe` is running, close it normally before `npm run dist`; Windows will otherwise lock the release directory. Never force-kill it without first ruling out unsaved text tabs.

Generated directories are intentionally ignored:

- `node_modules/` — recreated with `npm ci`
- `dist/` — recreated with `npm run build`
- `release/` — recreated with `npm run dist`, but keep the current `win-unpacked` directory because file associations point to it

## Supported formats

- `.md`, `.markdown`, `.txt`, and untitled files — CodeMirror Markdown mode with live preview
- `.json` — CodeMirror JSON mode without live preview
- `.jsonl` — line-aware JSON mode without live preview
- `.epub` — binary read-only EPUB surface; reflowable and DRM-free books only

EPUB data must use the binary `read-epub` IPC path. Do not pass EPUB files through UTF-8 text I/O. Fixed-layout, DRM-protected, and invalid books should remain closable tabs with explicit error states.

Publisher typography is intentionally overridden by the user's Moth font, size, padding, and spacing settings. Code and preformatted content keep the application monospace font.

## File associations

The current per-user ProgIDs are:

- `.md` / `.markdown` → `Moth.md`
- `.txt` → `Moth.txt`
- `.json` → `Moth.json`
- `.jsonl` → `Moth.jsonl`
- `.epub` → `Moth.epub`

All handlers point to `release/win-unpacked/Moth.exe`. Use `npm run register-associations` to refresh them. The script must not forge or directly overwrite Windows' protected `UserChoice` hash. `MDViewer.md` appears only as a legacy ProgID that the script removes after Windows no longer reports a live UserChoice reference.

## Design constraints

- Preserve the existing compact, dark, low-chroma visual language. `.impeccable.md` contains the detailed design context.
- Keep editor typography, spacing, settings, sidebar rhythm, and native window controls visually continuous with the established app.
- Tabs use natural width when space is available, then shrink to a readable minimum, then scroll horizontally. The new-file and settings controls must remain reachable.
- EPUB UI should reuse the existing sidebar and settings language rather than look like a separate web reader.
- Local fonts are bundled; do not add runtime font or CDN dependencies.

## Reliability constraints

- Dirty text tabs require confirmation before tab or window close.
- Save operations must mark only the exact written snapshot as saved; edits made while a write is pending stay dirty.
- Renames may change language modes among text formats, but must not silently convert between text and EPUB surfaces.
- EPUB resize, navigation, settings, and relocated events are serialized/coalesced so stale events cannot move the reader back to an earlier chapter.
- EPUB scripts and popups remain disabled. Treat book HTML and CSS as untrusted input.

## Shortcuts

- `Ctrl+N` — New file
- `Ctrl+S` — Save
- `Ctrl+F` — Find
- `Ctrl+H` — Find and Replace
- `Ctrl+O` — Open file
- `Ctrl+W` — Close tab
- `Ctrl+B` — Toggle sidebar

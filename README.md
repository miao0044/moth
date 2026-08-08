# Moth

Moth is a dark, minimal Windows editor and reader built with Electron and CodeMirror 6.

## Features

- Markdown and TXT editing with live preview
- JSON and line-aware JSONL syntax highlighting
- Reflowable, DRM-free EPUB reading with table of contents, chapter navigation, and saved reading position
- App-controlled reading fonts and spacing instead of publisher typography
- Persistent per-tab editors and adaptive tabs that compress when the title bar gets crowded
- Portable Windows build with per-user file association support

## Development

```powershell
npm ci
npm run qa
npm start
```

Build the portable app with:

```powershell
npm run dist
```

The resulting executable is `release/win-unpacked/Moth.exe`. This is also the executable used by the registered file associations.

To register the supported file types for the current Windows user:

```powershell
npm run register-associations
```

## Project layout

- `main.js` — Electron main process and local file IPC
- `renderer.js` — tabs, editor/reader lifecycle, settings, and shortcuts
- `src/editor/` — CodeMirror editor source
- `src/epub/` — EPUB reader surface and theme integration
- `src/fonts/` — bundled application fonts
- `scripts/qa-electron.cjs` — Electron integration regression suite
- `scripts/register-file-associations.ps1` — safe per-user Windows association setup
- `CLAUDE.md` — project guidance for coding agents

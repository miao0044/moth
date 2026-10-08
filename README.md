# Moth

Moth is a dark, minimal desktop editor and reader built with Electron and CodeMirror 6.

## Features

- Markdown and TXT editing with live preview
- JSON and line-aware JSONL syntax highlighting
- Reflowable, DRM-free EPUB reading with table of contents, chapter navigation, and saved reading position
- App-controlled reading fonts and spacing instead of publisher typography
- Persistent per-tab editors and adaptive tabs that compress when the title bar gets crowded
- Quiet Save and File menu icons, with Lexend UI text and keyboard-accessible confirmations
- Recovery drafts and the previous workspace restored after restart, independently of the original files
- Version-checked atomic saves, external-change notices, and no-overwrite renames
- Save All, Save / Discard / Cancel on close, recent files, and reopen closed tabs
- Linux desktop installation and portable Windows builds with file association support

## Development

```powershell
npm ci
npm run qa  # storage, editor/reader, and feature integration checks
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

## File safety and recovery

Moth checkpoints recovery drafts after a short typing pause and at least every two seconds while typing continuously. Drafts are stored privately in `session.json` and `session.json.bak` under Electron's user-data directory (`~/.config/moth` on this Linux installation). This does not save changes into the original documents. Discarding edits removes them from both recovery snapshots. Corrupt snapshots are retained for inspection while a valid backup is recovered.

Original files are saved through a synced temporary file in the destination directory and an atomic replacement. Moth checks the disk version before committing, preserves ordinary file permissions and symbolic links, and refuses to overwrite an already-open destination. Files with multiple hard links require Save As, so saving cannot silently detach the links. Renaming never replaces an existing file.

A standalone launch opens a focused text editor immediately, restoring a text tab when available or creating a new one. File launches open the selected document directly.

The folder icon at the upper left opens the shared File menu, including Open File, Open Folder, Save As (`Ctrl+Shift+S`), Save All (`Ctrl+Alt+S`), Reload from Disk, Reopen Closed Tab (`Ctrl+Shift+T`), and recent files. The same menu stays at the left of the tab strip when the file sidebar is hidden. The quick Save icon remains on the right. Necessary app-owned text and confirmation dialogs use bundled Lexend; document typography remains configurable.

## Linux build

Run `npm run dist:linux` to produce `release/linux-unpacked`. On this workstation, `~/.local/bin/moth` starts `~/.local/opt/moth/moth`, which loads `resources/app.asar`. Save open documents and close Moth normally before replacing the installed archive. Keep a rollback copy of the previous archive.

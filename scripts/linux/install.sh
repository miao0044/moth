#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/opt/moth"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor"
MIME_DIR="$HOME/.local/share/mime"
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Determine where the built app is
if [ -d "$1" ] 2>/dev/null; then
  BUILD_OUTPUT="$1"
elif [ -d "$SRC_DIR/release/linux-unpacked" ]; then
  BUILD_OUTPUT="$SRC_DIR/release/linux-unpacked"
else
  echo "Usage: $0 <path-to-linux-unpacked>" >&2
  echo "  or run from repo root after electron-builder --linux dir" >&2
  exit 1
fi

# Refuse if Moth is running
if pgrep -f "$INSTALL_DIR/moth" >/dev/null 2>&1; then
  echo "Moth is running. Please close it first." >&2
  exit 1
fi

echo "Installing from: $BUILD_OUTPUT"

# Atomic install: rsync to staging, then mv
STAGING="$INSTALL_DIR.staging.$$"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$(dirname "$INSTALL_DIR")"
rsync -a --delete "$BUILD_OUTPUT/" "$STAGING/"
# Remove SUID sandbox helper — Moth uses the user namespace sandbox via AppArmor
rm -f "$STAGING/chrome-sandbox"
if [ -d "$INSTALL_DIR" ]; then
  OLD="$INSTALL_DIR.old.$$"
  mv "$INSTALL_DIR" "$OLD"
  mv "$STAGING" "$INSTALL_DIR"
  rm -rf "$OLD"
else
  mv "$STAGING" "$INSTALL_DIR"
fi
trap - EXIT

# Wrapper script with fcitx5 support
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/moth" << 'WRAPPER'
#!/bin/sh
export GTK_IM_MODULE=fcitx
exec "$HOME/.local/opt/moth/moth" "$@"
WRAPPER
chmod +x "$BIN_DIR/moth"

# Desktop entry
mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/moth.desktop" << 'DESKTOP'
[Desktop Entry]
Name=Moth
Comment=A dark, minimal text editor and EPUB reader
Exec=moth %F
Icon=moth
Terminal=false
Type=Application
Categories=Utility;TextEditor;
MimeType=text/plain;text/markdown;application/json;application/jsonl;application/epub+zip;
StartupWMClass=Moth
DESKTOP

# Icons
for size in 16 24 32 48 64 128 256; do
  dest="$ICONS_DIR/${size}x${size}/apps"
  mkdir -p "$dest"
  cp "$SRC_DIR/build/icon-${size}.png" "$dest/moth.png"
done
mkdir -p "$ICONS_DIR/scalable/apps"
cp "$SRC_DIR/build/icon.svg" "$ICONS_DIR/scalable/apps/moth.svg"

# Custom MIME type for .jsonl
mkdir -p "$MIME_DIR/packages"
cat > "$MIME_DIR/packages/moth-jsonl.xml" << 'MIME'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/jsonl">
    <comment>JSON Lines</comment>
    <sub-class-of type="text/plain"/>
    <glob pattern="*.jsonl"/>
  </mime-type>
</mime-info>
MIME

# Update databases
update-mime-database "$MIME_DIR"
gtk-update-icon-cache "$ICONS_DIR" 2>/dev/null || true
update-desktop-database "$APPS_DIR" 2>/dev/null || true

echo "Moth installed to $INSTALL_DIR"
echo "Wrapper at $BIN_DIR/moth"
echo ""
echo "Next steps:"
echo "  1. Install AppArmor profile (one-time):"
echo "     sudo install -m 644 $SRC_DIR/scripts/linux/moth.apparmor /etc/apparmor.d/moth"
echo "     sudo apparmor_parser -r /etc/apparmor.d/moth"
echo "  2. Set as default: bash $SRC_DIR/scripts/linux/set-defaults.sh"

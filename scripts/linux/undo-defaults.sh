#!/usr/bin/env bash
set -euo pipefail

MIMEAPPS="$HOME/.config/mimeapps.list"

# Find most recent backup
BACKUP=$(ls -t "$MIMEAPPS".bak.* 2>/dev/null | head -1)

if [ -z "$BACKUP" ]; then
  echo "No backup found for $MIMEAPPS" >&2
  exit 1
fi

echo "Restoring from: $BACKUP"
cp "$BACKUP" "$MIMEAPPS"

kbuildsycoca6 2>/dev/null || kbuildsycoca5 2>/dev/null || true

echo "Restored. Current defaults:"
echo "  text/plain:       $(xdg-mime query default text/plain)"
echo "  text/markdown:    $(xdg-mime query default text/markdown)"
echo "  application/json: $(xdg-mime query default application/json)"

#!/usr/bin/env bash
set -euo pipefail

MIMEAPPS="$HOME/.config/mimeapps.list"
MIME_DIR="$HOME/.local/share/mime"

# Verify moth.desktop exists
if ! [ -f "$HOME/.local/share/applications/moth.desktop" ]; then
  echo "moth.desktop not found. Run install.sh first." >&2
  exit 1
fi

# Backup current mimeapps.list
if [ -f "$MIMEAPPS" ]; then
  cp "$MIMEAPPS" "$MIMEAPPS.bak.$(date +%Y%m%d%H%M%S)"
  echo "Backed up $MIMEAPPS"
fi

# Set Moth as default for our types
MOTH_TYPES=(
  text/plain
  text/markdown
  application/json
  application/jsonl
  application/epub+zip
)

for mime in "${MOTH_TYPES[@]}"; do
  xdg-mime default moth.desktop "$mime"
done
echo "Set moth.desktop as default for: ${MOTH_TYPES[*]}"

# Compute all descendant MIME types of text/plain and application/json
# that should NOT open in Moth (to prevent inheritance cascade)
collect_descendants() {
  local parent="$1"
  find "$MIME_DIR" /usr/share/mime -name '*.xml' -path '*/packages/*' 2>/dev/null \
    | xargs grep -l "sub-class-of" 2>/dev/null \
    | xargs grep -oP "type=\"[^\"]+\"" 2>/dev/null \
    | sort -u \
    | sed 's/type="//;s/"//' || true

  # Also check the subclasses file directly
  for base in "$MIME_DIR" /usr/share/mime; do
    if [ -f "$base/subclasses" ]; then
      grep "^${parent} " "$base/subclasses" 2>/dev/null | awk '{print $2}' || true
    fi
  done
}

get_all_subclasses() {
  local base_dir
  for base_dir in "$MIME_DIR" /usr/share/mime; do
    if [ -f "$base_dir/subclasses" ]; then
      cat "$base_dir/subclasses"
    fi
  done | sort -u
}

# Recursively find all descendants
find_descendants() {
  local parent="$1"
  local subclasses
  subclasses="$(get_all_subclasses)"
  local queue=("$parent")
  local visited=()
  local result=()

  while [ ${#queue[@]} -gt 0 ]; do
    local current="${queue[0]}"
    queue=("${queue[@]:1}")

    local children
    children=$(echo "$subclasses" | awk -v p="$current" '$2 == p {print $1}')
    for child in $children; do
      local already=false
      for v in "${visited[@]+"${visited[@]}"}"; do
        if [ "$v" = "$child" ]; then already=true; break; fi
      done
      if ! $already; then
        visited+=("$child")
        result+=("$child")
        queue+=("$child")
      fi
    done
  done
  printf '%s\n' "${result[@]+"${result[@]}"}"
}

# Types Moth owns — don't block these
MOTH_OWNED=(
  text/plain
  text/markdown
  application/json
  application/jsonl
  application/epub+zip
)

is_moth_owned() {
  local t="$1"
  for own in "${MOTH_OWNED[@]}"; do
    if [ "$t" = "$own" ]; then return 0; fi
  done
  return 1
}

echo "Computing descendant MIME types to exclude..."
DESCENDANTS=()
for parent in text/plain application/json; do
  while IFS= read -r desc; do
    [ -z "$desc" ] && continue
    if ! is_moth_owned "$desc"; then
      DESCENDANTS+=("$desc")
    fi
  done < <(find_descendants "$parent")
done

# Deduplicate
UNIQUE_DESCENDANTS=($(printf '%s\n' "${DESCENDANTS[@]+"${DESCENDANTS[@]}"}" | sort -u))

if [ ${#UNIQUE_DESCENDANTS[@]} -eq 0 ]; then
  echo "No descendant types found to exclude."
else
  echo "Excluding ${#UNIQUE_DESCENDANTS[@]} descendant types from Moth"

  # Ensure [Removed Associations] section exists and add entries
  if ! grep -q '^\[Removed Associations\]' "$MIMEAPPS" 2>/dev/null; then
    echo "" >> "$MIMEAPPS"
    echo "[Removed Associations]" >> "$MIMEAPPS"
  fi

  for desc in "${UNIQUE_DESCENDANTS[@]}"; do
    # Only add if not already present
    if ! grep -q "^${desc}=.*moth\.desktop" "$MIMEAPPS" 2>/dev/null; then
      # Check if key exists in [Removed Associations]
      if grep -q "^${desc}=" "$MIMEAPPS" 2>/dev/null; then
        sed -i "/^\[Removed Associations\]/,/^\[/{s|^${desc}=.*|${desc}=moth.desktop;|}" "$MIMEAPPS"
      else
        sed -i "/^\[Removed Associations\]/a ${desc}=moth.desktop;" "$MIMEAPPS"
      fi
    fi
  done
fi

# Refresh KDE's cache
kbuildsycoca6 2>/dev/null || kbuildsycoca5 2>/dev/null || true

echo ""
echo "Done. Verify with:"
echo "  xdg-mime query default text/plain        # → moth.desktop"
echo "  xdg-mime query default text/x-python      # → NOT moth"
echo "  xdg-mime query default application/json   # → moth.desktop"

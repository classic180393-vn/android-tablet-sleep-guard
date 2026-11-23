#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX_BIN="${PREFIX:-/usr/local}/bin"
TARGET_LINK="$PREFIX_BIN/tablet-guard"

echo "=== Android Tablet Sleep Guard Installer ==="

if ! command -v node >/dev/null 2>&1; then
  echo "Missing Node.js (>= 18). Install with: pkg install nodejs" >&2
  exit 1
fi

chmod +x "$REPO_DIR/bin/tablet-guard.js" "$REPO_DIR/scripts/oem-soft-sleep.sh" "$REPO_DIR/scripts/install-termux-boot.sh"

node "$REPO_DIR/bin/tablet-guard.js" init

if [ -d "$PREFIX_BIN" ] && [ -w "$PREFIX_BIN" ]; then
  ln -sf "$REPO_DIR/bin/tablet-guard.js" "$TARGET_LINK"
  echo "Linked CLI binary -> $TARGET_LINK"
else
  echo "Add alias manually: alias tablet-guard='node $REPO_DIR/bin/tablet-guard.js'"
fi

echo ""
echo "Next steps:"
echo "  1. Edit config: \${ATSG_CONFIG:-\$HOME/.config/android-tablet-sleep-guard/config.json}"
echo "  2. Start daemons: tablet-guard daemon start"
echo "  3. Check live state: tablet-guard status"

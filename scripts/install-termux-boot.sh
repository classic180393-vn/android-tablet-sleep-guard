#!/usr/bin/env bash
set -euo pipefail

BOOT_DIR="$HOME/.termux/boot"
BOOT_SCRIPT="$BOOT_DIR/start-tablet-sleep-guard.sh"
mkdir -p "$BOOT_DIR"

cat << 'EOF' > "$BOOT_SCRIPT"
#!/data/data/com.termux/files/usr/bin/bash
sleep 5
if command -v tablet-guard >/dev/null 2>&1; then
  tablet-guard daemon start >/dev/null 2>&1 || true
fi
EOF

chmod +x "$BOOT_SCRIPT"
echo "Installed Termux:Boot autostart hook -> $BOOT_SCRIPT"

#!/usr/bin/env bash
# ==============================================================================
# Safe OEM Background Package Soft-Sleep Manager (Android / Termux / ADB)
# - Restricts background wakeups WITHOUT disabling or uninstalling ROM APKs,
#   preserving safe OTA updates & normal reboot stability.
# - NEVER touches android.uid.system (uid=1000) shared core packages.
# ==============================================================================
set -u

ACTION="${1:-status}"
CONFIG_FILE="${ATSG_CONFIG:-$HOME/.config/android-tablet-sleep-guard/config.json}"

# Optional built-in Lenovo ZUI / ZUXOS isolated bloatware preset (separate UIDs only)
ZUI_GROUP_A_DEFAULT=(
  "com.lenovo.leos.appstore"
  "com.lenovo.lfh.tianjiao.tablet"
  "com.zui.ai.aiservice"
  "com.lenovo.levoice_agent"
  "com.lenovo.levoice.caption"
  "com.zui.browser"
  "com.zui.xlog"
  "com.baidu.map.location"
  "com.tblenovo.tabpushout"
  "com.lenovo.xiaotian.trigger"
  "com.tblenovo.lenovowhatsnew"
)

if ! command -v adb >/dev/null 2>&1; then
  echo "adb binary not found; skipping OEM soft-sleep."
  exit 0
fi

ADB_SERIAL="${ANDROID_SERIAL:-}"
if [ -z "$ADB_SERIAL" ]; then
  ADB_SERIAL="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{print $1; exit}')"
fi
if [ -z "$ADB_SERIAL" ]; then
  echo "No ADB device attached; skipping OEM soft-sleep."
  exit 0
fi

PKG_REGEX='^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$'

PACKAGES=()
if [ -f "$CONFIG_FILE" ] && command -v node >/dev/null 2>&1; then
  while IFS= read -r line; do
    [ -n "$line" ] && PACKAGES+=("$line")
  done < <(node -e '
    const fs = require("fs");
    const pkgRe = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
    try {
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (Array.isArray(c.oemStoppablePackages) && c.oemStoppablePackages.length > 0) {
        for (const p of c.oemStoppablePackages) {
          if (typeof p === "string" && pkgRe.test(p)) console.log(p);
        }
      } else if (c.oemSoftSleepPreset === "lenovo-zui") {
        console.log("__PRESET_LENOVO_ZUI__");
      }
    } catch {}
  ' "$CONFIG_FILE")
fi

if [ "${#PACKAGES[@]}" -eq 1 ] && [ "${PACKAGES[0]}" = "__PRESET_LENOVO_ZUI__" ]; then
  PACKAGES=("${ZUI_GROUP_A_DEFAULT[@]}")
fi

if [ "${#PACKAGES[@]}" -eq 0 ]; then
  echo "No OEM packages configured (oemStoppablePackages is empty)."
  exit 0
fi

for pkg in "${PACKAGES[@]}"; do
  if ! [[ "$pkg" =~ $PKG_REGEX ]]; then
    echo "[SKIP] Invalid package name: $pkg" >&2
    continue
  fi
  case "$ACTION" in
    sleep)
      adb -s "$ADB_SERIAL" shell "cmd appops set $pkg RUN_ANY_IN_BACKGROUND ignore 2>/dev/null || true"
      adb -s "$ADB_SERIAL" shell "am set-standby-bucket $pkg restricted 2>/dev/null || true"
      adb -s "$ADB_SERIAL" shell "am force-stop $pkg 2>/dev/null || true"
      echo "[SLEEP] $pkg -> restricted + force-stopped"
      ;;
    wake)
      adb -s "$ADB_SERIAL" shell "cmd appops set $pkg RUN_ANY_IN_BACKGROUND default 2>/dev/null || true"
      adb -s "$ADB_SERIAL" shell "am set-standby-bucket $pkg active 2>/dev/null || true"
      echo "[WAKE]  $pkg -> active + default"
      ;;
    status|*)
      bucket="$(adb -s "$ADB_SERIAL" shell "am get-standby-bucket $pkg 2>/dev/null" | tr -d '\r' || true)"
      echo "[STATUS] $pkg -> standby_bucket=${bucket:-unknown}"
      ;;
  esac
done

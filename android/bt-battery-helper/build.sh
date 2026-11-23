#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${ANDROID_JAR:-}" ]; then
  for sdk_dir in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk"; do
    [ -n "$sdk_dir" ] && [ -d "$sdk_dir/platforms" ] || continue
    ANDROID_JAR="$(find "$sdk_dir/platforms" -maxdepth 2 -name 'android.jar' 2>/dev/null | sort -V | tail -n 1 || true)"
    [ -n "${ANDROID_JAR:-}" ] && [ -f "$ANDROID_JAR" ] && break
  done
fi

if [ -z "${ANDROID_JAR:-}" ] || [ ! -f "$ANDROID_JAR" ]; then
  echo "Missing android.jar (set ANDROID_JAR=/path/to/android.jar)" >&2
  exit 1
fi

TMP_BASE="${TMPDIR:-/tmp}"
mkdir -p "$TMP_BASE"
BUILD_DIR="$(mktemp -d "${TMP_BASE%/}/atsg_btbat_build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

KEYSTORE_PASS="${KEYSTORE_PASS:-android}"
KEY_PASS="${KEY_PASS:-$KEYSTORE_PASS}"
GEN_ALIAS="${KEY_ALIAS:-androiddebugkey}"
export KEYSTORE_PASS KEY_PASS

if [ -z "${KEYSTORE:-}" ]; then
  DEFAULT_KS="$HOME/.android/debug.keystore"
  if [ "${USE_EPHEMERAL_KEYSTORE:-0}" != "1" ] && [ -f "$DEFAULT_KS" ] \
    && keytool -list -keystore "$DEFAULT_KS" -storepass:env KEYSTORE_PASS -alias "$GEN_ALIAS" >/dev/null 2>&1; then
    KEYSTORE="$DEFAULT_KS"
  else
    KEYSTORE="$BUILD_DIR/debug.keystore"
  fi
fi

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storepass:env KEYSTORE_PASS -alias "$GEN_ALIAS" \
    -keypass:env KEY_PASS -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi

mkdir -p "$BUILD_DIR/bin"
aapt2 link -o "$BUILD_DIR/bin/unaligned.apk" \
  --manifest "$SCRIPT_DIR/AndroidManifest.xml" \
  -I "$ANDROID_JAR" --auto-add-overlay

javac --release 11 -cp "$ANDROID_JAR" -d "$BUILD_DIR/bin" \
  "$SCRIPT_DIR/src/com/atsg/btbattery/"*.java

d8 --min-api 26 --output "$BUILD_DIR/bin" \
  "$BUILD_DIR/bin/com/atsg/btbattery/"*.class

python3 -c '
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], "a") as z:
    z.write(sys.argv[2], "classes.dex")
' "$BUILD_DIR/bin/unaligned.apk" "$BUILD_DIR/bin/classes.dex"

zipalign -f 4 "$BUILD_DIR/bin/unaligned.apk" "$BUILD_DIR/bin/aligned.apk"
SIGN_ARGS=(--ks "$KEYSTORE" --ks-pass env:KEYSTORE_PASS --key-pass env:KEY_PASS)
if [ -n "${KEY_ALIAS:-}" ]; then
  SIGN_ARGS+=(--ks-key-alias "$KEY_ALIAS")
fi
apksigner sign "${SIGN_ARGS[@]}" \
  --out "$BUILD_DIR/atsg_btbattery.apk" "$BUILD_DIR/bin/aligned.apk"

OUT_APK="${OUT_APK:-$SCRIPT_DIR/dist/atsg_btbattery.apk}"
mkdir -p "$(dirname "$OUT_APK")"
cp "$BUILD_DIR/atsg_btbattery.apk" "$OUT_APK"
echo "Built APK -> $OUT_APK"

#!/bin/bash
# build-jonah-mac.sh - builds Jonah for Mac on a Mac: Apple Silicon (arm64) and Intel (x64), each its own Jonah.app and .dmg
# (like Electron Jonah's electron-builder "mac" targets: dmg + zip for x64 and arm64, macOS 13 or newer).
#
# Needs: a Mac with macOS 13+, full Xcode (not only the command line tools) with its license accepted, about 200 GB free, 16 GB+ RAM.
# Chromium for Mac can only be built on a Mac (Apple's compilers, SDK and actool run only on macOS); this script was prepared on the
# Windows build PC and has NOT been run yet.
#
#   ./build-jonah-mac.sh <path to jonah-156.0.8078.96-stepNN.patch> [arm64|x64|both]
#
# Downloads (official sources only): depot_tools and the Chromium source from chromium.googlesource.com (about 100 GB with history
# trimmed), plus the toolchain gclient fetches from Google's storage. Nothing else.
set -euo pipefail

PATCH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
WHICH="${2:-both}"
VERSION="156.0.8078.96"          # the Chromium version Jonah is built on (same as Windows)
APP_VERSION="1.5.5"              # Electron Jonah's version (package.json)
WORK="${WORK:-$HOME/jonah-src}"
OUT_DIR="${OUT_DIR:-$HOME/jonah-mac-builds}"

echo "== Jonah for Mac: Chromium $VERSION + $(basename "$PATCH") -> $OUT_DIR ($WHICH)"
xcode-select -p | grep -q "Xcode.app" || { echo "Full Xcode is needed (xcode-select -s /Applications/Xcode.app)"; exit 1; }

# 1. depot_tools (Chromium's build tools)
if [ ! -d "$WORK/depot_tools" ]; then
  mkdir -p "$WORK"
  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$WORK/depot_tools"
fi
export PATH="$WORK/depot_tools:$PATH"

# 2. the Chromium source at Jonah's version
if [ ! -d "$WORK/chromium/src" ]; then
  mkdir -p "$WORK/chromium" && cd "$WORK/chromium"
  fetch --nohooks --no-history chromium
fi
cd "$WORK/chromium/src"
git fetch --depth=1 origin "refs/tags/$VERSION:refs/tags/$VERSION"
git checkout -f "tags/$VERSION"
gclient sync -D --force --no-history --with_tags

# 3. Jonah's changes (the same patch the Windows build uses: browser UI, built-in pages, Noah, icons, ...)
git apply --whitespace=nowarn "$PATCH"

# 4. the app icon: compile Jonah's icon catalog (chrome/app/theme/chromium/mac/Assets.xcassets, made from the owner's logo by
#    scripts/make_icons.py) into Assets.car - only Apple's actool can make it; without this the Mac would show Chromium's icon
TMP_ASSETS="$(mktemp -d)"
xcrun actool chrome/app/theme/chromium/mac/Assets.xcassets --compile "$TMP_ASSETS" --platform macosx \
  --minimum-deployment-target 13.0 --app-icon AppIcon --output-partial-info-plist "$TMP_ASSETS/partial.plist" >/dev/null
cp "$TMP_ASSETS/Assets.car" chrome/app/theme/chromium/mac/Assets.car

# 5. build each Mac: same settings as Windows' release build (no debug checks, no symbols), one folder per processor
build_one() {
  local cpu="$1"
  local out="out/Jonah-mac-$cpu"
  gn gen "$out" --args="is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 dcheck_always_on=false \
    disable_fieldtrial_testing_config=true chrome_pgo_phase=0 target_cpu=\"$cpu\" mac_deployment_target=\"13.0\""
  autoninja -C "$out" chrome
  local app
  app="$(ls -d "$out"/*.app | head -1)"
  echo "== built $app"

  # an ad-hoc signature (no Apple Developer ID here): the app runs on this Mac; on another Mac, open it with right-click > Open once.
  # (For downloads without that warning, sign with your Developer ID and notarize - Electron Jonah also had notarize: false.)
  codesign --force --deep --sign - "$app"

  # the .dmg: Jonah + a link to Applications (Electron Jonah's dmg layout)
  local stage
  stage="$(mktemp -d)"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  mkdir -p "$OUT_DIR"
  hdiutil create -volname "Jonah $APP_VERSION" -srcfolder "$stage" -ov -format UDZO "$OUT_DIR/Jonah-$APP_VERSION-$cpu.dmg"
  (cd "$(dirname "$app")" && ditto -c -k --keepParent "$(basename "$app")" "$OUT_DIR/Jonah-$APP_VERSION-$cpu-mac.zip")
  echo "== $OUT_DIR/Jonah-$APP_VERSION-$cpu.dmg"
}
case "$WHICH" in
  arm64) build_one arm64 ;;
  x64) build_one x64 ;;
  both) build_one arm64; build_one x64 ;;
  *) echo "arm64, x64 or both"; exit 1 ;;
esac
echo "== done: $(ls "$OUT_DIR")"

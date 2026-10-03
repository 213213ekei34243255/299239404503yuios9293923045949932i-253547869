#!/bin/bash
# Jonah installer for macOS - a few kilobytes. It finds the right build for THIS Mac (Apple Silicon or Intel), downloads it from Jonah's
# GitHub Releases, checks its checksum, and installs Jonah.app. Nothing here is hidden: read it before you run it.
#
#   Double-click this file (first time: right-click -> Open -> Open, because it is not signed), or paste in Terminal:
#     curl -fsSL https://github.com/OWNER/REPO/releases/latest/download/install-jonah-mac.command | bash
#
# Test switches (not needed normally):
#   JONAH_RELEASE_JSON=file.json   read the release description from a file instead of GitHub
#   JONAH_FORCE_ARCH=x64|arm64     pretend to be that kind of Mac
#   JONAH_INSTALL_DRY_RUN=1        say what would be downloaded and stop
set -euo pipefail

OWNER="213213ekei34243255"
REPO="299239404503yuios9293923045949932i-253547869"
API="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"

say()  { printf '%s\n' "$*"; }
fail() { printf 'Jonah installer: %s\n' "$*" >&2; exit 1; }

# 1. Which Mac is this? (sysctl sees the real chip even if Terminal is running under Rosetta)
if [ -n "${JONAH_FORCE_ARCH:-}" ]; then
  ARCH="$JONAH_FORCE_ARCH"
elif [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
else
  case "$(uname -m)" in arm64) ARCH="arm64" ;; x86_64) ARCH="x64" ;; *) fail "unsupported processor: $(uname -m)" ;; esac
fi
case "$ARCH" in x64|arm64) ;; *) fail "unknown architecture: $ARCH" ;; esac
say "This Mac: $([ "$ARCH" = arm64 ] && echo 'Apple Silicon' || echo 'Intel')"

# 2. What is the latest published release?
if [ -n "${JONAH_RELEASE_JSON:-}" ]; then
  JSON="$(cat "$JONAH_RELEASE_JSON")"
else
  JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || fail "could not reach GitHub (no internet, or no published release yet)"
fi

urls() { printf '%s' "$JSON" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -e 's/.*:[[:space:]]*"//' -e 's/"$//'; }
ZIP_URL="$(urls | grep -E "/Jonah-[0-9][0-9A-Za-z.+-]*-${ARCH}\.zip$" | head -n 1 || true)"
SUMS_URL="$(urls | grep -E '/SHA256SUMS\.txt$' | head -n 1 || true)"
[ -n "$ZIP_URL" ]  || fail "this release has no download for ${ARCH} Macs"
[ -n "$SUMS_URL" ] || fail "this release has no checksum file; refusing to install an unchecked download"
ZIP_NAME="${ZIP_URL##*/}"
say "Latest version file: ${ZIP_NAME}"
if [ "${JONAH_INSTALL_DRY_RUN:-}" = "1" ]; then say "DRY RUN: would download ${ZIP_URL}"; exit 0; fi

# 3. Download and check
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
say "Downloading Jonah (this is the large part)..."
curl -fL --progress-bar -o "$WORK/$ZIP_NAME" "$ZIP_URL" || fail "download failed"
curl -fsSL -o "$WORK/SHA256SUMS.txt" "$SUMS_URL" || fail "could not download the checksum file"
EXPECTED="$(grep -E "[[:space:]]\*?${ZIP_NAME}\$" "$WORK/SHA256SUMS.txt" | head -n 1 | awk '{print $1}')"
[ -n "$EXPECTED" ] || fail "no checksum listed for ${ZIP_NAME}"
ACTUAL="$(shasum -a 256 "$WORK/$ZIP_NAME" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || fail "the download is damaged or was changed (checksum mismatch). Nothing was installed."
say "Checksum OK."

# 4. Install
ditto -x -k "$WORK/$ZIP_NAME" "$WORK/unpacked"
APP="$(find "$WORK/unpacked" -maxdepth 2 -name 'Jonah.app' -type d | head -n 1)"
[ -n "$APP" ] || fail "the download did not contain Jonah.app"

DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
osascript -e 'tell application "Jonah" to quit' >/dev/null 2>&1 || true   # replacing a running copy would fail
sleep 1
rm -rf "$DEST/Jonah.app"
ditto "$APP" "$DEST/Jonah.app"
xattr -dr com.apple.quarantine "$DEST/Jonah.app" 2>/dev/null || true

say "Installed Jonah in ${DEST}."
open "$DEST/Jonah.app" || true

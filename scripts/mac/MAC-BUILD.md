# Jonah for Mac (Apple Silicon and Intel)

Prepared on the Windows build PC on 2026-11-18. **Not built or tested yet**: Chromium for Mac can only be compiled on a Mac.

## What is ready
- **App icon**: the owner's purple whale (`downloads/jonah-app-icon.png`) is in every Mac icon source:
  `chrome/app/theme/chromium/mac/app.icns` (16-1024 px) and `Assets.xcassets` (AppIcon + Icon.iconset), placed on Apple's icon grid
  (the tile at 824 of 1024 px) so it sits the same size as other Dock icons. `scripts/make_icons.py` makes them.
- **Built-in pages on Mac**: `ComponentLoader::AddJonahExtension()` now runs on Mac too, and `chrome/BUILD.gn` copies Jonah's built-in
  extension into the framework's `Resources/jonah` (`jonah_extension_bundle_data`, written by `make_jonah_extension.py`).
- **Build script**: `build-jonah-mac.sh <patch> [arm64|x64|both]` fetches Chromium 156.0.8078.96, applies Jonah's patch, compiles the icon
  catalog into `Assets.car` with Apple's `actool`, builds `out/Jonah-mac-arm64` and `out/Jonah-mac-x64` separately (same settings as the
  Windows release build), ad-hoc signs, and makes `Jonah-1.5.5-arm64.dmg` / `Jonah-1.5.5-x64.dmg` (+ zips) with the Applications link, like
  Electron Jonah's electron-builder mac targets.

## Needs on the Mac
macOS 13+, full Xcode with its license accepted, ~200 GB free, 16 GB+ RAM. A first build takes several hours per processor.

## Expected first-build work (honest list)
- Jonah's browser-UI changes were written and compiled for Windows only. Shared code should compile on Mac, but expect a few Mac compile
  errors on the first run (for example code that only exists on Windows). They are fixed on the Mac.
- **Noah's helper (`noah-native`) is Windows-only today**: the computer agent, file attachments, chat web search and speech recognition run
  in it (PowerShell, Windows OCR, `node.exe`). The Mac version needs: Node for Mac (Chromium's `third_party/node/mac`), Electron Jonah's
  `Noah/desktop/host-mac.js` (already in the Electron project) instead of PowerShell, the Mac native-messaging location, and packaging into
  the app. Until then, on Mac: browsing, the new tab, Noah's chat (without attachments/search), the web agent work; the computer agent does not.
- **Signing**: the script signs ad-hoc (no Apple Developer ID on this PC). Downloaded on another Mac, the app opens with right-click > Open
  the first time. For a clean download, sign with the owner's Developer ID and notarize.
- Mac permission texts (microphone for the voice orb, camera for websites): Chromium's own Info.plist entries are used; Electron Jonah's
  wording (`package.json` > build.mac.extendInfo) can be put there.

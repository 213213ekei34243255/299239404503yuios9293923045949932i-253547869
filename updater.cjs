// updater.cjs — checks GitHub Releases (the `build.publish` block in package.json) for a newer Jonah and applies it.
//
//   Windows: downloads in the background and installs when the app is next closed (or "Restart now" if the user picks it).
//   macOS:   macOS only installs updates for SIGNED apps, and Jonah's Mac build is unsigned, so there it does NOT download or install
//            anything: it tells the user a new version exists and opens the release page. Flip `installOnMac` once the Mac app is signed.
//
// An update can never be forced, never shows an error dialog (being offline is normal), and never runs in an unpackaged/dev run.
// electron-updater checks the downloaded installer against the SHA-512 in the release's latest.yml before it will install it.
"use strict";

const SIX_HOURS = 6 * 60 * 60 * 1000;

// Where releases live. Must equal package.json build.publish (a unit test checks it). It is repeated here on purpose: electron-builder
// strips the "build" section from the package.json inside the installed app, so the app cannot read it at run time.
const RELEASE_REPO = { owner: "213213ekei34243255", repo: "299239404503yuios9293923045949932i-253547869" };

function createUpdater({ autoUpdater, dialog, shell, app, getWindow = () => null, platform = process.platform, owner, repo, installOnMac = false, intervalMs = SIX_HOURS, setIntervalFn = setInterval, log = () => {} }) {
  const releasesUrl = `https://github.com/${owner}/${repo}/releases/latest`;
  const willAutoInstall = platform !== "darwin" || installOnMac;
  let started = false;
  let notifiedVersion = null; // never nag twice about the same version in one run
  let checking = false;

  const win = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : null; };
  const ask = (opts) => { const w = win(); return w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts); };

  async function onAvailable(info) {
    const v = info && info.version;
    log("update available:", v);
    if (willAutoInstall || !v || notifiedVersion === v) return; // Windows: it is already downloading, nothing to ask yet
    notifiedVersion = v;
    const r = await ask({ type: "info", buttons: ["Download", "Later"], defaultId: 0, cancelId: 1, title: "Update available", message: `Jonah ${v} is available.`, detail: `You have ${app.getVersion()}. Download the new version from the release page and install it over the old one.` });
    if (r && r.response === 0) await shell.openExternal(releasesUrl);
  }

  async function onDownloaded(info) {
    const v = info && info.version;
    log("update downloaded:", v);
    if (notifiedVersion === v) return;
    notifiedVersion = v;
    const r = await ask({ type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1, title: "Update ready", message: `Jonah ${v} is ready to install.`, detail: "It will be installed automatically the next time you close Jonah, or you can restart now." });
    if (r && r.response === 0) autoUpdater.quitAndInstall();
  }

  async function checkNow() {
    if (checking) return false;
    checking = true;
    try { await autoUpdater.checkForUpdates(); return true; }
    catch (e) { log("update check failed:", e && e.message); return false; } // offline, rate-limited, no release yet: all normal
    finally { checking = false; }
  }

  function start() {
    if (started) return false;
    if (!app.isPackaged) { log("updater: not checking in a development run"); return false; }
    started = true;
    autoUpdater.autoDownload = willAutoInstall;
    autoUpdater.autoInstallOnAppQuit = willAutoInstall;
    autoUpdater.allowPrerelease = false; // drafts and pre-releases are never offered
    autoUpdater.allowDowngrade = false;
    autoUpdater.on("update-available", (i) => { onAvailable(i).catch((e) => log("update prompt failed:", e && e.message)); });
    autoUpdater.on("update-downloaded", (i) => { onDownloaded(i).catch((e) => log("update prompt failed:", e && e.message)); });
    autoUpdater.on("error", (e) => log("updater error:", e && e.message));
    checkNow();
    const t = setIntervalFn(checkNow, intervalMs);
    if (t && typeof t.unref === "function") t.unref(); // never keeps the app alive
    return true;
  }

  return { start, checkNow, releasesUrl, willAutoInstall };
}

module.exports = { createUpdater, RELEASE_REPO };

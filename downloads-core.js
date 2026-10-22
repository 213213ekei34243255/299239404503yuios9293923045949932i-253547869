// downloads-core.js - the pure logic of the Downloads page: sizes, speeds, time left, file types, safe names, grouping by day. No DOM, no files, no clock of its own
// (tests pass the time in). Used by the page as window.DownloadsCore and by the main process (downloads/manager.cjs) as a module.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DownloadsCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;
  const UNITS = ["B", "KB", "MB", "GB", "TB"];

  /** 1024-based sizes the way file managers show them: "0 B", "812 KB", "45.6 MB", "1.20 GB". */
  function fmtBytes(n) {
    n = Number(n);
    if (!Number.isFinite(n) || n < 0) return "0 B";
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2).replace(/\.?0+$/, "")) + " " + UNITS[i];
  }
  const fmtSpeed = (bps) => (Number.isFinite(bps) && bps > 0 ? fmtBytes(bps) + "/s" : "");
  /** Seconds -> "12 s", "4 min 05 s", "1 h 05 min". null/NaN/negative -> "". */
  function fmtEta(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "";
    sec = Math.round(sec);
    if (sec < 60) return sec + " s";
    if (sec < 3600) return Math.floor(sec / 60) + " min " + String(sec % 60).padStart(2, "0") + " s";
    return Math.floor(sec / 3600) + " h " + String(Math.floor((sec % 3600) / 60)).padStart(2, "0") + " min";
  }
  /** 0..100, or null when the total size is unknown (the bar then shows activity instead of a percentage). */
  const pct = (received, total) => (Number(total) > 0 ? Math.max(0, Math.min(100, Math.floor((Number(received) / Number(total)) * 100))) : null);
  /** Exponential smoothing so the speed reading does not jump around. */
  const smooth = (prev, sample, alpha = 0.3) => (prev === null || prev === undefined || !Number.isFinite(prev) ? sample : prev + alpha * (sample - prev));
  /** Seconds left, only when the speed is real (a few KB/s) and the total is known. */
  const etaSec = (received, total, bps) => (Number(total) > 0 && bps >= 1024 && received < total ? (total - received) / bps : null);

  // ------------------------------------------------------------------ file types
  const KINDS = {
    archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "iso", "img"], document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "csv", "epub", "md"],
    image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "tif", "tiff", "psd"], video: ["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v"],
    audio: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"], app: ["exe", "msi", "dmg", "pkg", "apk", "deb", "rpm", "appimage", "bat", "cmd", "scr", "com", "jar", "ps1", "vbs", "hta", "lnk", "sh", "app"],
    code: ["js", "ts", "py", "html", "css", "json", "xml", "java", "c", "cpp", "cs", "go", "rs"],
  };
  /** Types that can run code when opened: the page asks "open anyway?" first and the main process refuses without that yes. */
  const RISKY = new Set(["exe", "msi", "bat", "cmd", "scr", "com", "jar", "ps1", "vbs", "hta", "lnk", "dmg", "pkg", "apk", "sh", "app", "js", "reg", "msix", "appx", "cpl", "wsf"]);
  const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };
  function typeInfo(name) {
    const ext = extOf(name);
    let kind = "other";
    for (const [k, list] of Object.entries(KINDS)) if (list.includes(ext)) { kind = k; break; }
    return { ext, kind, label: ext ? ext.slice(0, 4).toUpperCase() : "FILE", risky: RISKY.has(ext) };
  }
  const isRisky = (name) => typeInfo(name).risky;

  // ------------------------------------------------------------------ names
  /** A file name that is safe to create: no folders, no reserved characters, no trailing dots, not a Windows device name, not endless. */
  function safeName(name) {
    let n = String(name == null ? "" : name).replace(/[\\/]+/g, "_").replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "").trim();
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = "_" + n;
    if (n.length > 180) { const ext = extOf(n); n = n.slice(0, ext ? 180 - ext.length - 1 : 180) + (ext ? "." + ext : ""); }
    return n || "download";
  }
  /** "report.pdf" -> "report (1).pdf", "report (2).pdf"... the first one not in `taken` (compared without regard to capitals, as Windows does). */
  function uniqueName(name, taken) {
    const set = taken instanceof Set ? taken : new Set(taken || []);
    const has = (n) => set.has(n.toLowerCase());
    if (!has(name)) return name;
    const dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; i < 10000; i++) { const c = `${base} (${i})${ext}`; if (!has(c)) return c; }
    return `${base} (${Date.now()})${ext}`;
  }
  /** The site a download came from, for display ("example.com"); "" when the address is not a normal web address. */
  function sourceHost(url) { try { const u = new URL(String(url)); return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : ""; } catch (_) { return ""; } }

  // ------------------------------------------------------------------ the list
  const ACTIVE = new Set(["downloading", "paused", "interrupted"]);
  const isActive = (d) => d.status === "downloading" || d.status === "paused";
  /** Newest first, grouped "Today" / "Yesterday" / "Earlier this week" / "Earlier". `now` is a Date or ms. */
  function groupByDay(list, now) {
    const nowMs = now instanceof Date ? now.getTime() : now, d0 = new Date(nowMs);
    const today = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
    const buckets = [["Today", []], ["Yesterday", []], ["Earlier this week", []], ["Earlier", []]];
    for (const d of (list || []).slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))) {
      const t = Date.parse(d.startedAt);
      const day = Number.isFinite(t) ? new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime() : 0;
      (day >= today ? buckets[0] : day >= today - DAY ? buckets[1] : day >= today - 6 * DAY ? buckets[2] : buckets[3])[1].push(d);
    }
    return buckets.filter(([, items]) => items.length).map(([label, items]) => ({ label, items }));
  }
  /** One line for the header / the floating chip: how many are running, the combined speed, and the overall progress. */
  function summary(list) {
    const running = (list || []).filter((d) => d.status === "downloading"), paused = (list || []).filter((d) => d.status === "paused");
    const known = running.filter((d) => d.total > 0);
    const received = known.reduce((n, d) => n + d.received, 0), total = known.reduce((n, d) => n + d.total, 0);
    const speed = running.reduce((n, d) => n + (d.speedBps || 0), 0);
    return { running: running.length, paused: paused.length, speedBps: speed, pct: total > 0 ? Math.floor((received / total) * 100) : null, etaSec: etaSec(received, total, speed) };
  }
  const statusText = (d) => ({ downloading: "Downloading", paused: "Paused", completed: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" }[d.status] || d.status);

  return { fmtBytes, fmtSpeed, fmtEta, pct, smooth, etaSec, typeInfo, isRisky, extOf, safeName, uniqueName, sourceHost, isActive, ACTIVE, groupByDay, summary, statusText, RISKY };
});

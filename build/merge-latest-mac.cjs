// build/merge-latest-mac.cjs - merge the Intel and the Apple Silicon `latest-mac.yml` into ONE file that lists both.
//
// Why: the two Mac builds run on different machines and each writes its own latest-mac.yml with only its own files. The update feed on
// the release can hold only one such file, and electron-updater picks the right download by looking at the file NAMES in it (an Apple
// Silicon Mac takes the "arm64" one, an Intel Mac ignores arm64 files). So the feed must list both, or one kind of Mac is offered the
// other's build.
//
//   node build/merge-latest-mac.cjs <intel latest-mac.yml> <arm64 latest-mac.yml> <output.yml>
//
// Text-based on purpose (no YAML library): it runs in the release job, which has no node_modules, and electron-builder's file is a small,
// fixed shape. Anything that does not look like that shape is refused rather than guessed at.
"use strict";

function parse(text, label) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const top = {};
  const files = [];
  let inFiles = false, cur = null;
  for (const line of lines) {
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    if (inFiles) {
      let m;
      if ((m = /^  - url:\s*(.+?)\s*$/.exec(line))) { cur = { url: m[1], rest: [] }; files.push(cur); continue; }
      if (cur && /^    \S/.test(line)) { cur.rest.push(line.trim()); continue; }
      if (line.trim() === "") continue;
      inFiles = false; cur = null; // a new top-level key ends the list
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) top[kv[1]] = kv[2];
  }
  if (!top.version) throw new Error(`${label}: no "version:" line`);
  if (files.length === 0) throw new Error(`${label}: no files listed`);
  for (const f of files) if (!f.rest.some((r) => /^sha512:/.test(r))) throw new Error(`${label}: "${f.url}" has no sha512`);
  return { top, files };
}

/** @returns {string} the merged YAML text */
function mergeLatestMac(intelText, armText) {
  const a = parse(intelText, "intel file"), b = parse(armText, "arm64 file");
  if (a.top.version !== b.top.version) throw new Error(`the two builds are different versions (${a.top.version} vs ${b.top.version})`);
  const seen = new Set();
  const files = [];
  for (const f of [...a.files, ...b.files]) { if (seen.has(f.url)) continue; seen.add(f.url); files.push(f); }
  const out = [`version: ${a.top.version}`, "files:"];
  for (const f of files) { out.push(`  - url: ${f.url}`); for (const r of f.rest) out.push(`    ${r}`); }
  // the legacy top-level path/sha512 (the default download) stay the Intel build's, as before; per-Mac choice is made from `files`
  for (const k of ["path", "sha512", "releaseDate"]) if (a.top[k] !== undefined) out.push(`${k}: ${a.top[k]}`);
  return out.join("\n") + "\n";
}

module.exports = { mergeLatestMac, parse };

if (require.main === module) {
  const fs = require("fs");
  const [, , intelPath, armPath, outPath] = process.argv;
  if (!intelPath || !armPath || !outPath) { console.error("usage: node merge-latest-mac.cjs <intel.yml> <arm64.yml> <out.yml>"); process.exit(2); }
  try {
    const merged = mergeLatestMac(fs.readFileSync(intelPath, "utf8"), fs.readFileSync(armPath, "utf8"));
    fs.writeFileSync(outPath, merged);
    console.log(`merged ${intelPath} + ${armPath} -> ${outPath}`);
  } catch (e) { console.error("merge-latest-mac: " + e.message); process.exit(1); }
}

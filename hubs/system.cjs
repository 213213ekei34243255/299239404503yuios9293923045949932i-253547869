// hubs/system.cjs - READ-ONLY readings of this computer for the Game Hub's "PC vitals": CPU load, memory, disks, network speed, battery, GPU and temperatures.
// Nothing here changes anything on the computer; it only reads.
//
// What was measured on the development PC (Windows 10, no administrator rights, 2026-10-21):
//  - Temperatures come from Windows' "Thermal Zone Information" performance counter (Win32_PerfFormattedData_Counters_ThermalZoneInformation): it needs NO administrator
//    rights, but it reports ACPI thermal ZONES (the laptop maker's sensors), which are not guaranteed to be the CPU core. They are labelled that way, never as "CPU".
//    The older MSAcpi_ThermalZoneTemperature class needs administrator rights and returned nothing.
//  - GPU temperature exists only where `nvidia-smi` is installed (NVIDIA cards). Intel/AMD graphics expose no temperature to Windows without special drivers: the
//    GPU is then listed by name only, and the panel says so instead of showing a made-up number.
//  - Battery, disks and network speed come from the same single PowerShell call. Everything is Windows-only for now; elsewhere the CPU/memory/uptime/disk readings
//    still work and the rest says "not available on this system yet".
"use strict";

const os = require("os");

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (n, d = 1) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const GB = 1024 ** 3;

// ------------------------------------------------------------------ pure parsers and rules

/** Windows thermal-zone rows -> [{ label, c }]. HighPrecisionTemperature is tenths of a Kelvin; Temperature is whole Kelvin. Readings outside 0-130 C are sensor noise and dropped. */
function parseThermal(rows) {
  const out = [];
  for (const r of arr(rows)) {
    const hp = num(r && r.HighPrecisionTemperature), k = num(r && r.Temperature);
    const c = hp !== null && hp > 0 ? hp / 10 - 273.15 : k !== null && k > 0 ? k - 273.15 : null;
    if (c === null || c < 0 || c > 130) continue;
    const name = String((r && r.Name) || "").replace(/^\\_TZ\./, "").replace(/^\\/, "") || "zone";
    out.push({ label: `Thermal zone ${name}`, c: round(c, 1) });
  }
  return out;
}

/** Win32_Battery -> { percent, state: "charging"|"on battery"|"full"|"on AC"|"unknown", minutesLeft|null }. EstimatedRunTime 71582788 means "unknown" (on mains). */
function parseBattery(rows) {
  const b = arr(rows)[0];
  if (!b) return null;
  const pct = num(b.EstimatedChargeRemaining), st = num(b.BatteryStatus), run = num(b.EstimatedRunTime);
  const state = st === 1 || st === 4 || st === 5 ? "on battery" : [6, 7, 8, 9].includes(st) ? "charging" : st === 3 ? "full" : st === 2 ? "on AC" : st === 11 ? "charging" : "unknown";
  return { percent: pct === null ? null : clamp(Math.round(pct), 0, 100), state, minutesLeft: state === "on battery" && run !== null && run > 0 && run < 71582788 ? run : null };
}

/** Win32_LogicalDisk -> [{ drive, totalGB, freeGB, usedPct }] */
function parseDisks(rows) {
  return arr(rows).map((d) => ({ drive: String(d.DeviceID || ""), total: num(d.Size), free: num(d.FreeSpace) })).filter((d) => d.drive && d.total > 0 && d.free !== null)
    .map((d) => ({ drive: d.drive, totalGB: round(d.total / GB, 1), freeGB: round(d.free / GB, 1), usedPct: Math.round((1 - d.free / d.total) * 100) }));
}

/** Network performance rows -> { rxBps, txBps, adapter } summing real adapters (those with a link speed, not tunnels). */
function parseNet(rows) {
  let rx = 0, tx = 0, best = null;
  for (const n of arr(rows)) {
    const name = String(n.Name || ""), bw = num(n.CurrentBandwidth) || 0;
    if (!bw || /teredo|isatap|loopback|tunnel|pseudo|rndis|virtual|vmware|hyper-v|bluetooth/i.test(name)) continue;
    const r = num(n.BytesReceivedPersec) || 0, t = num(n.BytesSentPersec) || 0;
    rx += r; tx += t; if (!best || r + t > best.r + best.t) best = { name, r, t };
  }
  return { rxBps: rx, txBps: tx, adapter: best ? best.name : "" };
}

/** `nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits` -> [{ name, tempC, utilPct, memUsedMB, memTotalMB, powerW }] */
function parseNvidia(csv) {
  return String(csv || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const f = l.split(",").map((x) => x.trim());
    if (f.length < 6) return null;
    return { name: f[0], tempC: num(f[1]), utilPct: num(f[2]), memUsedMB: num(f[3]), memTotalMB: num(f[4]), powerW: num(f[5]) };
  }).filter(Boolean);
}

/** CPU load between two os.cpus() snapshots -> percent busy (0-100), or null when there is no interval. */
function cpuLoad(prev, curr) {
  if (!prev || !curr || prev.length !== curr.length) return null;
  let busy = 0, total = 0;
  for (let i = 0; i < curr.length; i++) {
    const a = prev[i].times, b = curr[i].times;
    const idle = b.idle - a.idle, all = ["user", "nice", "sys", "idle", "irq"].reduce((s, k) => s + (b[k] - a[k]), 0);
    busy += all - idle; total += all;
  }
  return total > 0 ? Math.round((busy / total) * 100) : null;
}

/** Plain-language findings with rule-of-thumb thresholds (they are conventions, not a diagnosis). Most serious first. */
function findings(s) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const hot = s.temps && s.temps.length ? Math.max(...s.temps.map((t) => t.c)) : null;
  if (hot !== null && hot >= 95) add("bad", `A sensor reads ${hot.toFixed(0)}°C - that is very hot. Close heavy programs and let the fan breathe.`);
  else if (hot !== null && hot >= 85) add("warn", `A sensor reads ${hot.toFixed(0)}°C - running hot. Check the vents and what is using the CPU.`);
  if (s.gpus) for (const g of s.gpus) if (g.tempC !== null && g.tempC >= 85) add(g.tempC >= 93 ? "bad" : "warn", `${g.name} is at ${g.tempC}°C.`);
  if (s.battery && s.battery.percent !== null) {
    if (s.battery.state === "on battery" && s.battery.percent <= 20) add(s.battery.percent <= 10 ? "bad" : "warn", `Battery ${s.battery.percent}% and not charging - plug in soon.`);
    else if (s.battery.state === "on AC" && s.battery.percent <= 20) add("warn", `Battery is low (${s.battery.percent}%) even though it is plugged in.`);
  }
  for (const d of s.disks || []) if (d.freeGB < 15 || d.usedPct >= 92) add(d.freeGB < 5 ? "bad" : "warn", `Drive ${d.drive} has only ${d.freeGB} GB free (${d.usedPct}% used) - games and updates need room.`);
  if (s.memory && s.memory.usedPct >= 90) add("warn", `Memory is ${s.memory.usedPct}% used - close tabs or programs you are not using.`);
  if (s.cpu && s.cpu.loadPct !== null && s.cpu.loadPct >= 90) add("warn", `The CPU is ${s.cpu.loadPct}% busy.`);
  if (!out.length) add("ok", "Nothing looks wrong right now.");
  const rank = { bad: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ------------------------------------------------------------------ the collector

const PS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$o=[ordered]@{}",
  "$o.thermal=@(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | Select-Object Name,Temperature,HighPrecisionTemperature)",
  "$o.battery=@(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus,EstimatedRunTime)",
  "$o.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace)",
  "$o.net=@(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object Name,BytesReceivedPersec,BytesSentPersec,CurrentBandwidth)",
  "$o.gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM)",
  "$o | ConvertTo-Json -Compress -Depth 4",
].join("; ");

/** `run(cmd, args, timeoutMs)` must resolve to stdout text or reject. `osMod` is injectable for tests. */
function createMonitor({ run, osMod = os, platform = process.platform, statfs = null } = {}) {
  let prevCpu = null;
  const nvidiaPath = { checked: false, ok: false };
  async function windowsExtras() {
    const out = { thermal: [], battery: null, disks: [], net: { rxBps: 0, txBps: 0, adapter: "" }, gpuNames: [], notes: [] };
    try {
      const raw = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT], 12000);
      const j = JSON.parse(String(raw).trim());
      out.thermal = parseThermal(j.thermal); out.battery = parseBattery(j.battery); out.disks = parseDisks(j.disks); out.net = parseNet(j.net);
      out.gpuNames = arr(j.gpu).map((g) => ({ name: String(g.Name || ""), ramGB: num(g.AdapterRAM) ? round(num(g.AdapterRAM) / GB, 1) : null })).filter((g) => g.name);
    } catch (err) { out.notes.push("Windows did not answer the hardware query (" + String(err && err.message || err).slice(0, 80) + ")."); }
    return out;
  }
  async function nvidia() {
    if (nvidiaPath.checked && !nvidiaPath.ok) return [];
    try {
      const csv = await run("nvidia-smi", ["--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader,nounits"], 6000);
      nvidiaPath.checked = true; nvidiaPath.ok = true;
      return parseNvidia(csv);
    } catch (_) { nvidiaPath.checked = true; nvidiaPath.ok = false; return []; } // not installed = no NVIDIA card: remembered, never asked again
  }
  async function read() {
    const cpus = osMod.cpus();
    if (!prevCpu) { prevCpu = cpus; await new Promise((r) => setTimeout(r, 350)); }
    const nowCpus = osMod.cpus();
    const load = cpuLoad(prevCpu, nowCpus); prevCpu = nowCpus;
    const total = osMod.totalmem(), free = osMod.freemem();
    const snap = {
      platform, at: new Date().toISOString(),
      cpu: { model: String((cpus[0] && cpus[0].model) || "CPU").replace(/\s+/g, " ").trim(), threads: cpus.length, loadPct: load, speedMHz: cpus[0] ? cpus[0].speed : null },
      memory: { totalGB: round(total / GB, 1), freeGB: round(free / GB, 1), usedPct: Math.round((1 - free / total) * 100) },
      uptimeHours: round(osMod.uptime() / 3600, 1),
      temps: [], battery: null, disks: [], net: null, gpus: [], gpuNames: [], notes: [],
    };
    if (platform === "win32") {
      const [w, g] = await Promise.all([windowsExtras(), nvidia()]);
      snap.temps = w.thermal; snap.battery = w.battery; snap.disks = w.disks; snap.net = w.net; snap.gpuNames = w.gpuNames; snap.gpus = g; snap.notes.push(...w.notes);
      if (!snap.temps.length) snap.notes.push("This computer does not expose temperature sensors to Windows (some laptops and desktops do not).");
      if (!g.length) snap.notes.push(w.gpuNames.length ? `GPU temperature is only readable on NVIDIA cards (via nvidia-smi); ${w.gpuNames[0].name} does not expose one.` : "No GPU information was available.");
    } else {
      snap.notes.push("Temperature, battery, network speed and GPU readings are available on Windows only for now.");
      try { if (statfs) { const s = statfs("/"); const t = s.blocks * s.bsize, f = s.bavail * s.bsize; snap.disks = [{ drive: "/", totalGB: round(t / GB, 1), freeGB: round(f / GB, 1), usedPct: Math.round((1 - f / t) * 100) }]; } } catch (_) { /* no disk reading */ }
    }
    snap.findings = findings(snap);
    const allTemps = snap.temps.map((t) => t.c).concat(snap.gpus.map((g) => g.tempC).filter((c) => c !== null));
    snap.hottest = allTemps.length ? Math.max(...allTemps) : null;
    return snap;
  }
  return { read };
}

/** Real `run` for the main process: spawn with a timeout, resolve stdout. No shell, no user-controlled arguments anywhere. */
function spawnRun(cmd, args, timeoutMs) {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}

module.exports = { parseThermal, parseBattery, parseDisks, parseNet, parseNvidia, cpuLoad, findings, createMonitor, spawnRun, PS_SCRIPT };

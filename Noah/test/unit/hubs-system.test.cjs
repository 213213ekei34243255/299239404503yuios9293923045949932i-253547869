// Noah/test/unit/hubs-system.test.cjs - the PC vitals (hubs/system.cjs) against a REAL Windows snapshot captured 2026-10-21 and synthetic edge cases.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const S = require("../../../hubs/system.cjs");
const snap = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "hubs", "ps-snapshot.json"), "utf8"));

test("thermal zones: tenths of Kelvin -> Celsius, labelled as ZONES (never 'CPU'), noise dropped", () => {
  const t = S.parseThermal(snap.thermal);
  assert.ok(t.length >= 1);
  for (const x of t) { assert.match(x.label, /^Thermal zone /); assert.ok(x.c > 10 && x.c < 110, String(x.c)); }
  assert.deepEqual(S.parseThermal([{ Name: "\\_TZ.TZ00", Temperature: 326, HighPrecisionTemperature: 3262 }]), [{ label: "Thermal zone TZ00", c: 53.1 }]);
  assert.deepEqual(S.parseThermal([{ Name: "a", Temperature: 326, HighPrecisionTemperature: 0 }]).map((x) => x.c), [52.9], "falls back to whole Kelvin");
  assert.deepEqual(S.parseThermal([{ Name: "x", HighPrecisionTemperature: 10 }, { Name: "y", HighPrecisionTemperature: 9999 }, { Name: "z" }]), [], "0 K-ish and 700 C readings are sensor noise");
  assert.deepEqual(S.parseThermal(undefined), []);
});

test("battery: states, the 'unknown time' sentinel, a single object instead of an array, and no battery", () => {
  assert.deepEqual(S.parseBattery({ EstimatedChargeRemaining: 15, BatteryStatus: 2, EstimatedRunTime: 71582788 }), { percent: 15, state: "on AC", minutesLeft: null });
  assert.deepEqual(S.parseBattery([{ EstimatedChargeRemaining: 40, BatteryStatus: 1, EstimatedRunTime: 95 }]), { percent: 40, state: "on battery", minutesLeft: 95 });
  assert.equal(S.parseBattery([{ EstimatedChargeRemaining: 80, BatteryStatus: 6, EstimatedRunTime: 71582788 }]).state, "charging");
  assert.equal(S.parseBattery([{ EstimatedChargeRemaining: 100, BatteryStatus: 3 }]).state, "full");
  assert.equal(S.parseBattery([{ EstimatedChargeRemaining: 250, BatteryStatus: 1 }]).percent, 100);
  assert.equal(S.parseBattery([]), null); assert.equal(S.parseBattery(null), null);
  assert.ok(S.parseBattery(snap.battery) === null || S.parseBattery(snap.battery).percent >= 0);
});

test("disks: used percentage and GB", () => {
  const d = S.parseDisks([{ DeviceID: "C:", Size: 238797410304, FreeSpace: 11136888832 }, { DeviceID: "D:", Size: 0, FreeSpace: 0 }, { DeviceID: "", Size: 1, FreeSpace: 1 }]);
  assert.deepEqual(d, [{ drive: "C:", totalGB: 222.4, freeGB: 10.4, usedPct: 95 }]);
  assert.ok(S.parseDisks(snap.disks).length >= 1);
});

test("network: sums real adapters (USB tethering counts), ignores tunnels / virtual / zero-speed ones", () => {
  const n = S.parseNet([
    { Name: "Intel[R] Centrino[R] Wireless-N 2230", BytesReceivedPersec: 1000, BytesSentPersec: 200, CurrentBandwidth: 116000000 },
    { Name: "Teredo Tunneling Pseudo-Interface", BytesReceivedPersec: 99999, BytesSentPersec: 99999, CurrentBandwidth: 100000 },
    { Name: "Remote NDIS based Internet Sharing Device", BytesReceivedPersec: 5, BytesSentPersec: 5, CurrentBandwidth: 425984000 }, // USB tethering: a real connection, so it counts
    { Name: "Realtek PCIe GbE Family Controller", BytesReceivedPersec: 7, BytesSentPersec: 7, CurrentBandwidth: 0 },
  ]);
  assert.deepEqual(n, { rxBps: 1005, txBps: 205, adapter: "Intel[R] Centrino[R] Wireless-N 2230" });
  assert.equal(S.parseNet(snap.net).rxBps >= 0, true);
});

test("nvidia-smi CSV", () => {
  assert.deepEqual(S.parseNvidia("NVIDIA GeForce RTX 3060, 61, 23, 1500, 12288, 87.5\n"), [{ name: "NVIDIA GeForce RTX 3060", tempC: 61, utilPct: 23, memUsedMB: 1500, memTotalMB: 12288, powerW: 87.5 }]);
  assert.deepEqual(S.parseNvidia("NVIDIA X, [N/A], 5, 100, 200, [N/A]")[0].tempC, null, "[N/A] is null, not NaN");
  assert.deepEqual(S.parseNvidia(""), []); assert.deepEqual(S.parseNvidia("garbage line"), []);
});

test("CPU load between two snapshots", () => {
  const mk = (idle, busy) => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }, { times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
  assert.equal(S.cpuLoad(mk(0, 0), mk(100, 100)), 50);
  assert.equal(S.cpuLoad(mk(0, 0), mk(0, 100)), 100);
  assert.equal(S.cpuLoad(mk(5, 5), mk(5, 5)), null, "no time passed = no answer, not NaN");
  assert.equal(S.cpuLoad(null, mk(1, 1)), null);
});

test("findings: thresholds, ordering (worst first) and the all-clear", () => {
  const base = { temps: [], gpus: [], battery: null, disks: [], memory: { usedPct: 40 }, cpu: { loadPct: 20 } };
  assert.deepEqual(S.findings(base).map((f) => f.level), ["ok"]);
  const f = S.findings({ ...base, temps: [{ c: 96 }], battery: { percent: 8, state: "on battery" }, disks: [{ drive: "C:", freeGB: 10.4, usedPct: 95 }], memory: { usedPct: 93 }, cpu: { loadPct: 95 } });
  assert.equal(f[0].level, "bad"); assert.match(f[0].text, /96/);
  assert.ok(f.some((x) => /Battery 8%/.test(x.text)) && f.some((x) => /C: has only 10.4 GB/.test(x.text)) && f.some((x) => /Memory is 93%/.test(x.text)) && f.some((x) => /95% busy/.test(x.text)));
  assert.deepEqual(f.map((x) => x.level), [...f.map((x) => x.level)].sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a] - { bad: 0, warn: 1, ok: 2 }[b])));
  assert.match(S.findings({ ...base, temps: [{ c: 87 }] })[0].text, /running hot/);
  assert.equal(S.findings({ ...base, battery: { percent: 50, state: "on battery" } })[0].level, "ok");
});

test("the monitor on Windows reads the whole real snapshot, and says what it cannot read", async () => {
  const m = S.createMonitor({ run: async (cmd) => { if (cmd === "powershell.exe") return JSON.stringify(snap); throw Object.assign(new Error("not found"), { code: "ENOENT" }); }, platform: "win32" });
  const r = await m.read();
  assert.ok(r.cpu.threads >= 1 && r.memory.totalGB > 0 && r.memory.usedPct >= 0 && r.uptimeHours >= 0);
  assert.ok(r.temps.length >= 1 && r.hottest > 10);
  assert.ok(r.disks.length >= 1 && r.net);
  assert.deepEqual(r.gpus, [], "no nvidia-smi: no GPU temperature invented");
  assert.ok(r.notes.some((n) => /GPU temperature is only readable on NVIDIA/.test(n)));
  assert.ok(Array.isArray(r.findings) && r.findings.length >= 1);
});

test("the monitor survives a failing hardware query, and a PC without sensors says so", async () => {
  const bad = S.createMonitor({ run: async () => { throw new Error("boom"); }, platform: "win32" });
  const r = await bad.read();
  assert.ok(r.cpu && r.memory, "CPU and memory still come from Node");
  assert.ok(r.notes.some((n) => /did not answer the hardware query/.test(n)));
  const empty = S.createMonitor({ run: async (c) => { if (c === "powershell.exe") return JSON.stringify({ thermal: [], battery: [], disks: [], net: [], gpu: [] }); throw new Error("x"); }, platform: "win32" });
  const e = await empty.read();
  assert.equal(e.hottest, null); assert.ok(e.notes.some((n) => /does not expose temperature sensors/.test(n)));
  assert.equal(e.battery, null, "a desktop has no battery");
});

test("nvidia-smi is asked once: when it is missing it is remembered, and a present one gives GPU temperature", async () => {
  let asked = 0;
  const m = S.createMonitor({ run: async (c) => { if (c === "nvidia-smi") { asked++; throw new Error("ENOENT"); } return JSON.stringify(snap); }, platform: "win32" });
  await m.read(); await m.read(); await m.read();
  assert.equal(asked, 1);
  const g = S.createMonitor({ run: async (c) => (c === "nvidia-smi" ? "NVIDIA GeForce GTX 1650, 71, 90, 2000, 4096, 50" : JSON.stringify(snap)), platform: "win32" });
  const r = await g.read();
  assert.equal(r.gpus[0].tempC, 71); assert.equal(r.hottest >= 71, true);
  assert.ok(!r.notes.some((n) => /GPU temperature is only readable/.test(n)));
});

test("on other systems: CPU/memory/uptime/disk still read, and the rest is honestly 'Windows only'", async () => {
  const m = S.createMonitor({ run: async () => { throw new Error("must not run anything"); }, platform: "darwin", statfs: () => ({ blocks: 1000, bsize: 1073741824 / 1000 * 100, bavail: 250 }) });
  const r = await m.read();
  assert.ok(r.notes.some((n) => /Windows only/.test(n)));
  assert.equal(r.disks[0].drive, "/"); assert.equal(r.battery, null); assert.deepEqual(r.temps, []);
});

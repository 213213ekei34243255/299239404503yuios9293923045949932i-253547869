// Noah/test/unit/entitlement-device.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEntitlementDeviceStore, readMachineId, hardwareHash } = require("../../../entitlement-device.cjs");

function fakeKeychain(machineSecret) {
  const key = crypto.createHash("sha256").update(machineSecret).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]); },
    decryptString: (b) => { const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ent-dev-"));

test("hardwareHash is stable across restarts (same machine id -> same hash, every time)", () => {
  const a = hardwareHash("machine-A");
  const b = hardwareHash("machine-A");
  const c = hardwareHash("machine-B");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("the entitlement hash is namespaced differently from any other system's hash of the same machine id", () => {
  // the developer-access system (license-device.cjs) hashes "jonah-license-hw-v1:" + raw; this one must never collide with it
  const crypto2 = require("crypto");
  const licenseStyle = crypto2.createHash("sha256").update("jonah-license-hw-v1:machine-X").digest("hex");
  assert.notEqual(hardwareHash("machine-X"), licenseStyle);
});

test("load() creates a device on first call and returns the SAME identity on every later call (this run)", () => {
  const dir = tmpDir();
  const store = createEntitlementDeviceStore({ dir, safeStorage: fakeKeychain("k"), machineId: () => "MACHINE-1" });
  const a = store.load(), b = store.load();
  assert.equal(a.id, b.id);
  assert.equal(a.pub, b.pub);
  assert.equal(a.hardwareHash, hardwareHash("MACHINE-1"));
});

test("a restart (fresh process, same files, same machine) resolves to the identical keypair and hardwareHash", () => {
  const dir = tmpDir();
  const mk = () => createEntitlementDeviceStore({ dir, safeStorage: fakeKeychain("k"), machineId: () => "MACHINE-1" });
  const first = mk().load();
  const second = mk().load(); // a fresh store object, as a restarted app would create
  assert.equal(first.id, second.id);
  assert.equal(first.pub, second.pub);
});

test("clearing the app's own data (deleting the key file) on the SAME machine gives a NEW keypair but the SAME hardwareHash", () => {
  // this is the crux of "reinstall/clear app data must not reset the free trial": the SERVER recognises the device again by
  // hardwareHash even though the signing keypair (which lived only in this now-deleted file) is brand new.
  const dir = tmpDir();
  const mk = () => createEntitlementDeviceStore({ dir, safeStorage: fakeKeychain("k"), machineId: () => "MACHINE-1" });
  const before = mk().load();
  fs.rmSync(path.join(dir, "entitlement-device.json"));
  const after = mk().load();
  assert.notEqual(before.id, after.id, "a new credential, not reused");
  assert.notEqual(before.pub, after.pub);
  assert.equal(before.hardwareHash, after.hardwareHash, "but the entitlement identity itself is unchanged");
});

test("copying the key file to a DIFFERENT machine changes the hardwareHash (does not silently inherit the free trial state)", () => {
  const dirA = tmpDir();
  const a = createEntitlementDeviceStore({ dir: dirA, safeStorage: fakeKeychain("k"), machineId: () => "MACHINE-A" }).load();
  const dirB = tmpDir();
  fs.copyFileSync(path.join(dirA, "entitlement-device.json"), path.join(dirB, "entitlement-device.json"));
  const onB = createEntitlementDeviceStore({ dir: dirB, safeStorage: fakeKeychain("k"), machineId: () => "MACHINE-B" }).load();
  assert.equal(onB.id, a.id, "the credential file itself decrypts fine (same keychain secret in this test)");
  assert.notEqual(onB.hardwareHash, a.hardwareHash, "but it reports as a different entitlement identity on the new machine");
});

test("copying the key file to another user's keychain (undecryptable) yields a fresh credential, not a crash", () => {
  const dirA = tmpDir();
  createEntitlementDeviceStore({ dir: dirA, safeStorage: fakeKeychain("keychain-A"), machineId: () => "MACHINE-1" }).load();
  const dirB = tmpDir();
  fs.copyFileSync(path.join(dirA, "entitlement-device.json"), path.join(dirB, "entitlement-device.json"));
  const onB = createEntitlementDeviceStore({ dir: dirB, safeStorage: fakeKeychain("keychain-B"), machineId: () => "MACHINE-1" }).load();
  assert.ok(onB.pub, "a usable device was still produced");
});

test("sign() produces a real, verifiable Ed25519 signature over the given message, and nothing else verifies it", () => {
  const dir = tmpDir();
  const dev = createEntitlementDeviceStore({ dir, safeStorage: fakeKeychain("k"), machineId: () => "M" }).load();
  const sig = dev.sign("hello world");
  const raw = Buffer.from(dev.pub, "base64url");
  assert.equal(raw.length, 32, "the public key goes over the wire as the RAW 32-byte Ed25519 key (base64url), the format noahai.live verifies with");
  const pubKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  assert.equal(crypto.verify(null, Buffer.from("hello world"), pubKey, Buffer.from(sig, "base64url")), true);
  assert.equal(crypto.verify(null, Buffer.from("tampered"), pubKey, Buffer.from(sig, "base64url")), false);
});

test("without OS encryption available, the key is still stored (plain) and still works, never crashes", () => {
  const dir = tmpDir();
  const store = createEntitlementDeviceStore({ dir, safeStorage: { isEncryptionAvailable: () => false }, machineId: () => "M" });
  const dev = store.load();
  assert.ok(dev.pub);
  assert.equal(JSON.parse(fs.readFileSync(store.file, "utf8")).enc, "plain");
});

test("readMachineId returns a non-empty string on this real machine (Windows: MachineGuid)", () => {
  const id = readMachineId();
  assert.equal(typeof id, "string");
  if (process.platform === "win32" || process.platform === "darwin") assert.ok(id.length > 0, "a real OS machine id was read");
});

// entitlement-device.cjs — this Mac/PC's identity for the BILLING/ENTITLEMENT system (noahai.live). A separate, unrelated identity from
// the developer-access login system (mac-intel-build branch only): that one is a named account bound to one device; this one is an
// anonymous per-device entitlement identity with no signup at all, used to meter the free trial and paid plans for real customers.
//
// WHAT IS COLLECTED AND WHY (kept to exactly this, nothing more - see the spec's "do not overcollect hardware data"):
//   - One OS-provided persistent machine identifier: Windows' MachineGuid (a registry value the OS itself manages, unrelated to any
//     app), or macOS' IOPlatformUUID (a hardware-board identifier macOS exposes the same way to every app that asks). Never sent raw:
//     it is SHA-256 hashed with a fixed namespace string before it ever leaves this file, so the server never sees the real machine id,
//     only an opaque hash of it. This is what makes "reinstall/uninstall/clear app data does not reset the free trial" possible, per the
//     spec: it lives at the OS level, not inside anything Jonah's own installer or userData folder owns, so clearing Jonah's own data
//     cannot manufacture a new identity.
//   - An Ed25519 key PAIR this device generates itself on first run. Only the public key and its signatures ever leave the device; the
//     private key is encrypted at rest with the OS (Electron safeStorage -> Windows DPAPI / macOS Keychain) so a copied file is useless
//     without this exact OS user account. This key signs every entitlement request (so a network observer or another local process
//     cannot casually impersonate this device's session); it is NOT the entitlement identity itself - if this file is deleted (app data
//     cleared), register() below simply re-binds a freshly generated key to the SAME machine-id-derived identity, so no new free trial
//     is created. Nothing else about the machine (no MAC address, serial number, disk id, username, hostname, installed software) is
//     read or sent.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256Hex = (d) => crypto.createHash("sha256").update(d).digest("hex");
const NAMESPACE = "jonah-entitlement-hw-v1:"; // distinct from the developer-access system's own namespace, so the two hashes never match

// The one persistent, OS-level identifier this whole system is anchored to.
function readMachineId() {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 4000 });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return m[1];
    } else if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 4000, windowsHide: true });
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) return m[1];
    }
  } catch { /* fall through: hash of "" below still gives a stable (if uselessly shared) id rather than crashing */ }
  return "";
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * dir         this device's own folder to keep its key file in (app.getPath("userData")/entitlement — NOT the entitlement identity
 *             itself, only where the signing keypair happens to be cached; see the module docstring)
 * safeStorage Electron's safeStorage (or a stand-in in tests)
 */
function createEntitlementDeviceStore({ dir, safeStorage, machineId = readMachineId, fsImpl = fs }) {
  const file = path.join(dir, "entitlement-device.json");
  let cached = null;

  function hardwareHash() {
    return sha256Hex(NAMESPACE + machineId());
  }

  function build(privateKey) {
    const publicKey = crypto.createPublicKey(privateKey);
    const der = publicKey.export({ type: "spki", format: "der" });
    return {
      id: sha256Hex(der).slice(0, 32), // an opaque id for THIS keypair (device_credentials.id server-side), not the entitlement identity
      hardwareHash: hardwareHash(), // the entitlement identity itself: stable across reinstall/app-data-clear on the same machine
      // The wire format agreed with noahai.live: the RAW 32-byte Ed25519 public key, base64url. (A DER/SPKI wrapper is just this key
      // behind a fixed 12-byte prefix; sending the wrapped form made the server unable to verify any signature - "bad_signature".)
      pub: b64u(der.subarray(ED25519_SPKI_PREFIX.length)),
      sign: (message) => b64u(crypto.sign(null, Buffer.from(String(message)), privateKey)),
    };
  }

  function tryRead() {
    let saved;
    try { saved = JSON.parse(fsImpl.readFileSync(file, "utf8")); } catch { return null; }
    try {
      let der;
      if (saved.enc === "os") {
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
        der = Buffer.from(safeStorage.decryptString(Buffer.from(saved.priv, "base64")), "base64");
      } else if (saved.enc === "plain") der = Buffer.from(saved.priv, "base64");
      else return null;
      const key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      const dev = build(key);
      return dev.pub === saved.pub ? dev : null; // the stored public key must match the private key
    } catch { return null; } // copied from another Mac/user, or corrupted: cannot be decrypted -> a fresh keypair is generated below
  }

  function create() {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const der = privateKey.export({ type: "pkcs8", format: "der" });
    const dev = build(privateKey);
    const useOs = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    const record = { v: 1, enc: useOs ? "os" : "plain", pub: dev.pub, priv: useOs ? safeStorage.encryptString(der.toString("base64")).toString("base64") : der.toString("base64") };
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = file + ".tmp";
    fsImpl.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    return dev;
  }

  return {
    load() { if (!cached) cached = tryRead() || create(); return cached; },
    hardwareHash, // exposed on its own: register() needs it even before a keypair decision is finalised, and tests check it directly
    file,
  };
}

module.exports = { createEntitlementDeviceStore, readMachineId, hardwareHash: (m = readMachineId()) => sha256Hex(NAMESPACE + m) };

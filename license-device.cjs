// This Mac's identity for the licence system: an Ed25519 key pair made on first launch plus a hardware id.
//   - The PRIVATE key is stored encrypted with the operating system (Electron safeStorage -> the macOS Keychain). Copying the file to
//     another Mac gives an undecryptable blob, so a copied installation cannot sign anything and is treated as a new, unauthorized device.
//   - The server registers the public key (and the hardware hash) for the account on first login, and later demands a fresh signature
//     over a one-time challenge - so knowing a password or a refresh token is not enough to act as this Mac.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256Hex = (d) => crypto.createHash("sha256").update(d).digest("hex");

// The machine's own identifier. macOS: IOPlatformUUID. (Windows/Linux only matter for development.)
function readHardwareId() {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 4000 });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return m[1];
    } else if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 4000, windowsHide: true });
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) return m[1];
    } else {
      for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    }
  } catch { /* fall through */ }
  return "";
}

function deviceLabel() {
  return `${os.hostname()} (${process.platform} ${os.release()}, ${os.arch()})`.replace(/[^\x20-\x7E]/g, "").slice(0, 80);
}

/**
 * store: { load() -> { id, pub, hw, label, sign(message) } }
 *   dir         where the device file lives (the app's userData folder)
 *   safeStorage Electron's safeStorage (or a stand-in in tests)
 */
function createDeviceStore({ dir, safeStorage, hardwareId = readHardwareId, label = deviceLabel, fsImpl = fs }) {
  const file = path.join(dir, "license-device.json");
  let cached = null;

  function build(privateKey) {
    const publicKey = crypto.createPublicKey(privateKey);
    const der = publicKey.export({ type: "spki", format: "der" });
    const raw = hardwareId();
    return {
      id: sha256Hex(der).slice(0, 32),
      pub: b64u(der),
      // With no readable machine id the hash is of nothing: it still works, it just adds no second factor.
      hw: sha256Hex("jonah-license-hw-v1:" + raw),
      label: label(),
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
    } catch { return null; } // e.g. the blob was copied from another Mac/user: cannot be decrypted -> becomes a new device
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

  return { load() { if (!cached) cached = tryRead() || create(); return cached; }, file };
}

module.exports = { createDeviceStore, readHardwareId, deviceLabel };

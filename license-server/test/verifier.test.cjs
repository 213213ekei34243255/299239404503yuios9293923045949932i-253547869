// The drop-in backend verifiers (Node and Python) against tokens the real server issues.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const C = require("../src/crypto.cjs");
const { createVerifier } = require("../verifiers/verify-license-token.cjs");
const { makeDevice, newService, loginAs } = require("./helpers.cjs");

async function issue() {
  const env = newService();
  await env.service.createAccount({ username: "rohan_test", password: "Test-pass-1" }, "t");
  const s = await loginAs(env.service, makeDevice(), "rohan_test", "Test-pass-1");
  const keys = [{ kid: env.key.kid, spki: env.key.spki }];
  const claims = JSON.parse(Buffer.from(s.accessToken.split(".")[1], "base64url").toString());
  return { env, token: s.accessToken, keys, claims };
}

// every way a token can be wrong
function variants({ env, token, claims }) {
  const [h, p, s] = token.split(".");
  const stranger = C.keyInfo(crypto.generateKeyPairSync("ed25519").privateKey);
  const sign = (over, key = env.key) => C.signToken({ ...claims, ...over }, key);
  return {
    valid: token,
    raw: token,
    tampered: `${h}.${C.b64u(JSON.stringify({ ...claims, usr: "someone_else" }))}.${s}`,
    alg_none: `${C.b64u(JSON.stringify({ alg: "none", typ: "JLT", kid: env.key.kid }))}.${p}.`,
    alg_hs256: `${C.b64u(JSON.stringify({ alg: "HS256", typ: "JLT", kid: env.key.kid }))}.${p}.${s}`,
    wrong_key: C.signToken(claims, { ...stranger, kid: env.key.kid }),
    unknown_kid: C.signToken(claims, stranger),
    wrong_audience: sign({ aud: "another-app" }),
    wrong_issuer: sign({ iss: "someone-else" }),
    expired: sign({ iat: claims.iat - 1000, exp: claims.iat - 500 }),
    not_unlimited: sign({ unl: 0 }),
    garbage: "not.a.token",
    empty: "",
  };
}

const EXPECT = {
  valid: "ok", raw: "ok", tampered: "bad_signature", alg_none: "bad_alg", alg_hs256: "bad_alg", wrong_key: "bad_signature", unknown_kid: "unknown_kid",
  wrong_audience: "bad_audience", wrong_issuer: "bad_issuer", expired: "expired", not_unlimited: "not_unlimited", garbage: "malformed", empty: "malformed",
};

test("Node verifier: accepts a real token and refuses every kind of bad one", async () => {
  const t = await issue();
  const verifier = createVerifier({ keys: t.keys, now: () => t.claims.iat });
  for (const [name, token] of Object.entries(variants(t))) {
    const r = verifier.verify(token);
    if (EXPECT[name] === "ok") { assert.equal(r.ok, true, name); assert.equal(r.claims.usr, "rohan_test"); }
    else assert.deepEqual([name, r.ok, r.reason], [name, false, EXPECT[name]]);
  }
  assert.equal(verifier.verifyHeader("Bearer " + t.token).ok, true, "a Bearer prefix is fine");
  assert.equal(verifier.verifyHeader(undefined).ok, false);
  assert.throws(() => createVerifier({ keys: [] }));
});

test("Node verifier: a token stops working when it expires", async () => {
  const t = await issue();
  let now = t.claims.iat;
  const verifier = createVerifier({ keys: t.keys, now: () => now });
  assert.equal(verifier.verify(t.token).ok, true);
  now = t.claims.exp + 31;
  assert.equal(verifier.verify(t.token).reason, "expired");
});

test("Python verifier gives the same verdicts on the same tokens", async (ctx) => {
  const probe = spawnSync("python", ["-c", "import cryptography"], { encoding: "utf8" });
  if (probe.status !== 0) return ctx.skip("python with the cryptography package is not available");
  const t = await issue();
  const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jonah-pyv-")), "tokens.json");
  fs.writeFileSync(fixture, JSON.stringify({ keys: t.keys, now: t.claims.iat, tokens: variants(t) }));
  const run = spawnSync("python", [path.join(__dirname, "py_verifier_check.py"), fixture], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const got = JSON.parse(run.stdout);
  for (const [name, want] of Object.entries(EXPECT)) {
    const expected = want === "ok" ? "ok:rohan_test" : "refused:" + want;
    assert.equal(got[name], expected, name);
  }
});

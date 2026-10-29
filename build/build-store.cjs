// build/build-store.cjs - builds the Microsoft Store package (MSIX/AppX) of Jonah.
//
//   node build/build-store.cjs                      a LOCAL TEST package with placeholder identity: it can be inspected, but it can NOT be uploaded to the Store
//   node build/build-store.cjs --for-submission     the package to upload: refuses to run unless the three Partner Center values are given
//
// The three values come from Partner Center (Product management, Product Identity). Give them as environment variables or as arguments:
//   STORE_IDENTITY_NAME            Package/Identity/Name              e.g. 12345CogniAIStudios.Jonah
//   STORE_PUBLISHER                Package/Identity/Publisher         e.g. CN=ABCDEF12-3456-7890-ABCD-EF1234567890
//   STORE_PUBLISHER_DISPLAY_NAME   Package/Identity/PublisherDisplayName
//   (or --identity-name=... --publisher=... --publisher-display-name=...)   --out=<folder> chooses where the package goes (default: dist-store)
//
// It also refuses to package the wrong product: the Store version is the normal one (billing ON), never an unlimited or a sign-in-gated build.
// A Store package is updated BY THE STORE (main.cjs does not check GitHub when process.windowsStore is set), so a new version means a new submission in Partner Center.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PLACEHOLDER_PUBLISHER = "CN=00000000-0000-0000-0000-000000000000";

const argValue = (argv, name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined; };

/** The identity to build with: real values when all three are given, otherwise the placeholders in package.json (and the package is marked as a local test). */
function resolveIdentity({ env = process.env, argv = [], pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) } = {}) {
  const given = {
    identityName: argValue(argv, "identity-name") || env.STORE_IDENTITY_NAME,
    publisher: argValue(argv, "publisher") || env.STORE_PUBLISHER,
    publisherDisplayName: argValue(argv, "publisher-display-name") || env.STORE_PUBLISHER_DISPLAY_NAME,
  };
  const have = Object.values(given).filter(Boolean).length;
  const problems = [];
  if (have > 0 && have < 3) problems.push("Give all three Partner Center values (name, publisher, publisher display name), or none for a local test package.");
  if (given.identityName && !/^[A-Za-z0-9.-]{3,50}$/.test(given.identityName)) problems.push(`The identity name must be 3 to 50 letters, digits, dots or hyphens: "${given.identityName}".`);
  if (given.publisher && !/^CN=.+/.test(given.publisher)) problems.push(`The publisher must start with CN= (copy it exactly from Partner Center): "${given.publisher}".`);
  if (given.publisher === PLACEHOLDER_PUBLISHER) problems.push("That publisher is the placeholder, not a Partner Center value.");
  const real = have === 3 && problems.length === 0;
  const base = (pkg.build && pkg.build.appx) || {};
  return { problems, real, identity: real ? given : { identityName: base.identityName, publisher: base.publisher, publisherDisplayName: base.publisherDisplayName } };
}

/** The Store version is the public product: billing ON, no developer-login files. Returns a list of reasons it must not be packaged (empty = fine). */
function checkProduct(root = ROOT) {
  const bad = [];
  try { if (JSON.parse(fs.readFileSync(path.join(root, "entitlements.config.json"), "utf8")).enabled !== true) bad.push("entitlements.config.json says billing is OFF (an unlimited build): the Store version is the normal one, with billing ON."); } catch { bad.push("entitlements.config.json is missing or unreadable."); }
  for (const f of ["license-gate.cjs", "license-config.cjs", "license-config.generated.json"]) if (fs.existsSync(path.join(root, f))) bad.push(`${f} is present: a developer-login build must not go to the Store.`);
  if (fs.existsSync(path.join(root, "key.json"))) bad.push("key.json is present: it must never be packaged.");
  for (const n of ["StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png", "Wide310x150Logo.png"]) if (!fs.existsSync(path.join(root, "build", "appx", n))) bad.push(`build/appx/${n} is missing (Store tile image).`);
  return bad;
}

/** The electron-builder arguments (the identity is passed on the command line so package.json keeps its placeholders). */
function builderArgs({ identity, real, out, version }) {
  const name = `Jonah-${version}-store${real ? "" : "-LOCAL-TEST-ONLY"}.\${ext}`;
  return ["--win", "appx", "--x64", "--publish", "never",
    `-c.appx.identityName=${identity.identityName}`, `-c.appx.publisher=${identity.publisher}`, `-c.appx.publisherDisplayName=${identity.publisherDisplayName}`,
    `-c.appx.artifactName=${name}`, `-c.directories.output=${out}`];
}

function main(argv = process.argv.slice(2), env = process.env) {
  const forSubmission = argv.includes("--for-submission");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const id = resolveIdentity({ env, argv, pkg });
  if (id.problems.length) { id.problems.forEach((p) => console.error("ERROR:", p)); return 2; }
  if (forSubmission && !id.real) { console.error("ERROR: --for-submission needs the three Partner Center values (STORE_IDENTITY_NAME, STORE_PUBLISHER, STORE_PUBLISHER_DISPLAY_NAME). A package with placeholder values would be refused by the Store."); return 2; }
  const bad = argv.includes("--allow-any-product") ? [] : checkProduct();
  if (bad.length) { bad.forEach((p) => console.error("ERROR:", p)); return 2; }
  const out = path.resolve(argValue(argv, "out") || path.join(ROOT, "dist-store"));
  console.log(id.real ? `Building the Store package ${pkg.version} for ${id.identity.identityName} (${id.identity.publisherDisplayName}).` : "Building a LOCAL TEST package with PLACEHOLDER identity: it cannot be uploaded to the Store.");
  // electron-builder is run through Node itself (no shell), so a name with a space in it, like "CogniAI Studios", reaches it as ONE argument
  const cli = path.join(ROOT, "node_modules", "electron-builder", "cli.js");
  const r = spawnSync(process.execPath, [cli, ...builderArgs({ identity: id.identity, real: id.real, out, version: pkg.version })], { cwd: ROOT, stdio: "inherit" });
  if (r.status === 0) console.log(`Done: ${out}${id.real ? "" : " (local test only)"}`);
  return r.status || 0;
}

module.exports = { resolveIdentity, checkProduct, builderArgs, PLACEHOLDER_PUBLISHER };
if (require.main === module) process.exit(main());

// Noah/test/unit/release-repo.test.cjs - installers and updates come from a PUBLIC releases-only repository, so the source repository can stay private. Four places name it and must agree:
// package.json build.publish (copied into the installer and the app's updater), updater.cjs, the Mac installer script, and the release workflow that publishes there.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const PRIVATE_SOURCE_REPO = "299239404503yuios9293923045949932i-253547869";

test("package.json, updater.cjs and the Mac installer script name the same releases repository, and it is not the private source repository", () => {
  const pub = JSON.parse(read("package.json")).build.publish;
  const { RELEASE_REPO } = require("../../../updater.cjs");
  assert.equal(pub.provider, "github");
  assert.deepEqual({ owner: RELEASE_REPO.owner, repo: RELEASE_REPO.repo }, { owner: pub.owner, repo: pub.repo });
  const mac = read("build/install-jonah-mac.command");
  assert.match(mac, new RegExp(`^OWNER="${pub.owner}"$`, "m"));
  assert.match(mac, new RegExp(`^REPO="${pub.repo}"$`, "m"));
  for (const name of [pub.repo, RELEASE_REPO.repo]) assert.notEqual(name, PRIVATE_SOURCE_REPO, "the private source repository must not be where installers and updates are fetched from");
});

test("the release workflow publishes to that same repository with a token of its own, refuses to run without one, and checks the target is public", () => {
  const pub = JSON.parse(read("package.json")).build.publish;
  const wf = read(".github/workflows/release.yml");
  assert.match(wf, new RegExp(`RELEASES_REPO: ${pub.owner}/${pub.repo}`));
  assert.match(wf, /GH_TOKEN: \$\{\{ secrets\.RELEASES_TOKEN \}\}/);
  assert.match(wf, /The secret RELEASES_TOKEN is not set/);
  assert.match(wf, /grep -qx PUBLIC/);
  assert.match(wf, /gh release create "\$TAG" --repo "\$RELEASES_REPO"/);
  assert.match(wf, /gh release upload "\$TAG" \$FILES --clobber --repo "\$RELEASES_REPO"/);
  assert.match(wf, /s#OWNER_REPO#\$\{RELEASES_REPO\}#/, "the release notes' install command points at the public repository");
  const publishStep = wf.slice(wf.indexOf("Create or update the draft release in the public releases repository"));
  assert.doesNotMatch(publishStep, /--target/, "a commit of the private repository does not exist in the public one");
});

test("the token that reaches the public repository is never given to the build jobs (they only stage files in the private repository)", () => {
  const wf = read(".github/workflows/release.yml");
  const buildJob = wf.slice(wf.indexOf("  build:"), wf.indexOf("  release:"));
  assert.doesNotMatch(buildJob, /RELEASES_TOKEN/);
});

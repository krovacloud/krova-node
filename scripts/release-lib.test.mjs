import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineVersion, cmpSemver, nextVersion, pinsFor, planBaselines } from "./release-lib.mjs";

test("cmpSemver compares numerically, not as strings", () => {
  assert.ok(cmpSemver("0.10.0", "0.9.0") > 0);
  assert.ok(cmpSemver("0.5.0", "0.5.2") < 0);
  assert.equal(cmpSemver("1.2.3", "1.2.3"), 0);
});

test("baselineVersion takes the higher of committed and npm latest", () => {
  // The bug: committed 0.5.0 in git, 0.5.2 on npm. The dependent must pin 0.5.2.
  assert.equal(baselineVersion("0.5.0", "0.5.2"), "0.5.2");
  // A manual bump ahead of npm wins.
  assert.equal(baselineVersion("1.0.0", "0.5.2"), "1.0.0");
  assert.equal(baselineVersion("0.1.0", "0.1.0"), "0.1.0");
  // Never published: the committed version stands.
  assert.equal(baselineVersion("0.1.0", "0.0.0"), "0.1.0");
});

test("planBaselines skips private packages and flags the ones that lag npm", () => {
  const pkgs = [
    { name: "@krovacloud/sdk", dir: "packages/sdk", private: false, json: { version: "0.5.0" } },
    { name: "@krovacloud/ai-sdk", dir: "packages/ai-sdk", private: false, json: { version: "0.1.0" } },
    { name: "internal", dir: "packages/internal", private: true, json: { version: "0.0.1" } },
  ];
  const latest = { "@krovacloud/sdk": "0.5.2", "@krovacloud/ai-sdk": "0.1.0", internal: "9.9.9" };
  const plan = planBaselines(pkgs, (name) => latest[name]);
  assert.deepEqual(
    plan.map((b) => [b.name, b.version, b.rewrite]),
    [
      ["@krovacloud/sdk", "0.5.2", true],
      ["@krovacloud/ai-sdk", "0.1.0", false],
    ]
  );
});

test("nextVersion patch-increments npm latest unless committed is explicitly higher", () => {
  assert.equal(nextVersion("0.1.0", "0.1.0"), "0.1.1");
  assert.equal(nextVersion("0.5.2", "0.5.2"), "0.5.3");
  // Never published: the committed version is the first release.
  assert.equal(nextVersion("0.1.0", "0.0.0"), "0.1.0");
  assert.equal(nextVersion("0.6.0", "0.5.2"), "0.6.0");
});

test("a dependent pins an unreleased dependency to its npm latest, a released one to its new version", () => {
  const versions = new Map([["@krovacloud/sdk", baselineVersion("0.5.0", "0.5.2")]]);
  assert.deepEqual(pinsFor(["@krovacloud/sdk"], versions), [{ dep: "@krovacloud/sdk", version: "0.5.2" }]);
  versions.set("@krovacloud/sdk", nextVersion("0.5.2", "0.5.2"));
  assert.deepEqual(pinsFor(["@krovacloud/sdk"], versions), [{ dep: "@krovacloud/sdk", version: "0.5.3" }]);
});

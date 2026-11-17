// Monorepo auto-release. Run on a push to main (after build + test pass).
//
// For each publishable package, in dependency order (a package's internal deps
// publish first), decide whether it changed since its last release and, if so:
//   1. compute the next version — patch-increment the latest on npm, unless
//      package.json is explicitly higher (a manual major/minor bump wins),
//   2. write that version into the package's package.json,
//   3. `pnpm publish` it (pnpm rewrites any `workspace:*` dep to the real
//      version at publish time, using the just-bumped versions),
//   4. create a `<name>@<version>` git tag + a GitHub release.
//
// Before any of that, every publishable package's package.json is set to the
// higher of its committed version and its npm latest. git keeps the committed
// version from the last hand edit (the bumps below are never committed), so
// without this a dependent published while its dependency is unchanged would
// pin `workspace:*` to that stale committed version.
//
// "Changed" = the package directory has commits since its highest release tag
// (or it has never been released). No changesets, no manual version edits.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmpSemver, nextVersion, pinsFor, planBaselines } from "./release-lib.mjs";

const DRY = process.argv.includes("--dry-run");

const out = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const runLoud = (cmd, opts = {}) => {
  console.log(`  $ ${cmd}`);
  if (!DRY) execSync(cmd, { stdio: "inherit", ...opts });
};

// ── discover packages ────────────────────────────────────────────────────────
const dirs = readdirSync("packages")
  .map((d) => join("packages", d))
  .filter((d) => existsSync(join(d, "package.json")));

const pkgs = dirs.map((dir) => {
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return { dir, json, name: json.name, private: !!json.private };
});
const names = new Set(pkgs.map((p) => p.name));

// ── topological order (internal deps first) ──────────────────────────────────
const internalDeps = (p) =>
  Object.keys({ ...(p.json.dependencies || {}) }).filter((d) => names.has(d));
const ordered = [];
const seen = new Set();
const visit = (p) => {
  if (seen.has(p.name)) return;
  seen.add(p.name);
  for (const dep of internalDeps(p)) {
    const dp = pkgs.find((x) => x.name === dep);
    if (dp) visit(dp);
  }
  ordered.push(p);
};
pkgs.forEach(visit);

// ── helpers ──────────────────────────────────────────────────────────────────
const highestTag = (name) => {
  const tags = out(`git tag --list "${name}@*"`)
    .split("\n")
    .filter(Boolean)
    .map((t) => t.slice(name.length + 1))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort(cmpSemver);
  return tags.length ? tags[tags.length - 1] : null;
};

// Paths inside a package that never affect the PUBLISHED artifact — changing
// only these must NOT trigger a version bump/republish (no churn for repo
// hygiene: tests, tooling config, inert per-package .github, editor files).
const NON_PUBLISHED_GLOBS = [
  ".github/**",
  "test/**",
  "tests/**",
  "**/*.test.ts",
  "**/*.spec.ts",
  "tsconfig*.json",
  "tsup.config.*",
  "vitest.config.*",
  "eslint.config.*",
  ".eslintrc*",
  ".prettierrc*",
  ".editorconfig",
];

// package.json at a git ref with dev-only fields removed. `devDependencies`
// and `scripts` are never installed or run by a consumer of the published
// package, so a change confined to them must not force a new release.
const publishedManifest = (ref, dir) => {
  try {
    const json = JSON.parse(
      out(`git show ${ref}:${dir}/package.json`, { stdio: ["ignore", "pipe", "ignore"] })
    );
    delete json.devDependencies;
    delete json.scripts;
    return JSON.stringify(json);
  } catch {
    return null;
  }
};

const changedSince = (dir, name, tagVersion) => {
  if (!tagVersion) return true; // never released
  const tag = `${name}@${tagVersion}`;
  const excludes = NON_PUBLISHED_GLOBS.map((g) => `':(exclude)${dir}/${g}'`).join(" ");
  // Files in the package's published surface that changed since the last release.
  const changed = out(`git diff --name-only ${tag} HEAD -- ${dir} ${excludes}`)
    .split("\n")
    .filter(Boolean);
  if (changed.length === 0) return false;
  // If the ONLY change is package.json and it's confined to dev-only fields
  // (devDependencies / scripts), the published artifact is unchanged — skip.
  if (changed.length === 1 && changed[0] === `${dir}/package.json`) {
    const before = publishedManifest(tag, dir);
    const after = publishedManifest("HEAD", dir);
    if (before !== null && after !== null && before === after) return false;
  }
  return true;
};

// A 404 means the package was never published ("0.0.0"). Any other failure
// (network, registry outage) throws: guessing "0.0.0" would pin dependents to a
// stale committed version, which is the bug this script exists to prevent.
const npmLatest = (name) => {
  try {
    return out(`pnpm view ${name} version`) || "0.0.0";
  } catch (e) {
    if (/\b404\b|E404/.test(`${e.stderr ?? ""}${e.stdout ?? ""}`)) return "0.0.0";
    throw new Error(`could not read the npm latest of ${name}: ${e.stderr || e.message}`);
  }
};

// ── baseline versions ────────────────────────────────────────────────────────
// Set every publishable package to max(committed, npm latest) in this checkout
// so a `workspace:*` dependency that is not released this run still resolves to
// its real latest version. `versions` tracks what each package will be at when a
// dependent publishes; the loop below updates it for packages it releases.
const latestCache = new Map();
const latestOf = (name) => {
  if (!latestCache.has(name)) latestCache.set(name, npmLatest(name));
  return latestCache.get(name);
};
const versions = new Map();
for (const b of planBaselines(pkgs, latestOf)) {
  versions.set(b.name, b.version);
  if (!b.rewrite) continue;
  console.log(`~ ${b.name}: committed ${b.committed} is behind npm ${b.latest}, using ${b.version}`);
  const pjPath = join(b.dir, "package.json");
  const pj = JSON.parse(readFileSync(pjPath, "utf8"));
  pj.version = b.version;
  if (!DRY) writeFileSync(pjPath, `${JSON.stringify(pj, null, 2)}\n`);
  pkgs.find((p) => p.name === b.name).json.version = b.version;
}

// ── release loop ─────────────────────────────────────────────────────────────
let released = 0;
for (const p of ordered) {
  if (p.private) continue;
  const { dir, name, json } = p;
  const lastTag = highestTag(name);
  if (!changedSince(dir, name, lastTag)) {
    console.log(`= ${name}: unchanged since ${lastTag ?? "(never released)"} — skip`);
    continue;
  }

  const latest = latestOf(name);
  const next = nextVersion(json.version, latest); // an explicit higher manual bump wins

  console.log(`▸ ${name}: ${latest} → ${next} (releasing)`);
  for (const { dep, version } of pinsFor(internalDeps(p), versions)) {
    console.log(`    pins ${dep}@${version}`);
  }
  versions.set(name, next);
  // write the version so workspace:* dependents resolve to it at publish time
  const pjPath = join(dir, "package.json");
  const pj = JSON.parse(readFileSync(pjPath, "utf8"));
  pj.version = next;
  if (!DRY) writeFileSync(pjPath, `${JSON.stringify(pj, null, 2)}\n`);

  runLoud(`pnpm --filter ${name} publish --provenance --access public --no-git-checks`);
  runLoud(`git tag ${name}@${next}`);
  runLoud(`git push origin ${name}@${next}`);
  runLoud(
    `gh release create "${name}@${next}" --title "${name} v${next}" --notes "Automated release of ${name}@${next} on merge to main." || true`
  );
  released++;
}

console.log(released ? `\nReleased ${released} package(s).` : "\nNo packages changed — nothing to release.");

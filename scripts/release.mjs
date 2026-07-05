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
// "Changed" = the package directory has commits since its highest release tag
// (or it has never been released). No changesets, no manual version edits.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DRY = process.argv.includes("--dry-run");

const out = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const ok = (cmd) => {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
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
const cmpSemver = (a, b) => {
  const A = a.split(".").map(Number);
  const B = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d;
  }
  return 0;
};

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

const changedSince = (dir, name, tagVersion) => {
  if (!tagVersion) return true; // never released
  const tag = `${name}@${tagVersion}`;
  const excludes = NON_PUBLISHED_GLOBS.map((g) => `':(exclude)${dir}/${g}'`).join(" ");
  // exit code 1 => there ARE differences in the package's PUBLISHED surface
  return !ok(`git diff --quiet ${tag} HEAD -- ${dir} ${excludes}`);
};

const npmLatest = (name) => {
  try {
    return (
      out(`npm view ${name} version`, { stdio: ["ignore", "pipe", "ignore"] }) || "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
};

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

  const latest = npmLatest(name);
  let next;
  if (cmpSemver(json.version, latest) > 0) {
    next = json.version; // explicit manual bump wins
  } else {
    const parts = latest.split(".").map(Number);
    parts[2] = (parts[2] || 0) + 1;
    next = parts.join(".");
  }

  console.log(`▸ ${name}: ${latest} → ${next} (releasing)`);
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

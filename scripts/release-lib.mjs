// Pure helpers for scripts/release.mjs, split out so node:test can cover them
// without running a release (release.mjs has side effects at import time).

export const cmpSemver = (a, b) => {
  const A = a.split(".").map(Number);
  const B = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d;
  }
  return 0;
};

// The version a package is at BEFORE this run releases anything: the higher of
// the version committed in git and the latest on npm. git only holds the
// version from the last time someone edited package.json by hand (the release
// script bumps it in the CI checkout and never commits it), so it lags npm.
// pnpm rewrites `workspace:*` to whatever package.json says at publish time, so
// a dependency that is NOT being released this run must still read as its real
// latest version or its dependents publish pinned to a stale one.
export const baselineVersion = (committed, latest) =>
  cmpSemver(committed, latest) >= 0 ? committed : latest;

// For every non-private package, the baseline version and whether package.json
// has to be rewritten to it. `latestOf(name)` returns the npm latest ("0.0.0"
// for a package never published).
export const planBaselines = (pkgs, latestOf) =>
  pkgs
    .filter((p) => !p.private)
    .map((p) => {
      const committed = p.json.version;
      const latest = latestOf(p.name);
      const version = baselineVersion(committed, latest);
      return { name: p.name, dir: p.dir, committed, latest, version, rewrite: version !== committed };
    });

// The next version for a package that is being released: the committed version
// when it is explicitly higher than npm (a manual major/minor bump wins),
// otherwise the npm latest with its patch incremented.
export const nextVersion = (committed, latest) => {
  if (cmpSemver(committed, latest) > 0) return committed;
  const parts = latest.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
};

// What a package's internal dependencies will be pinned to when it publishes:
// each dependency's version in `versions` (name -> version), which holds the
// baseline for packages not released this run and the new version for those
// that are.
export const pinsFor = (internalDeps, versions) =>
  internalDeps.map((dep) => ({ dep, version: versions.get(dep) }));

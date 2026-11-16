/** A MAJOR.MINOR.PATCH version, plus its pre-release part when it has one. */
interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(input: string): ParsedVersion | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    input.trim()
  );
  if (!m) return undefined;
  const [major, minor, patch] = [m[1], m[2], m[3]];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  const pre = m[4];
  return {
    core: [Number(major), Number(minor), Number(patch)],
    pre: pre ? pre.split(".") : [],
  };
}

/** Semver ordering of two pre-release parts: numeric identifiers below
 *  alphanumeric ones, numbers compared as numbers, everything else as text. */
function comparePre(a: string[], b: string[]): number {
  // No pre-release outranks any pre-release of the same release.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
      continue;
    }
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer.
 *  A pre-release sorts below the release it leads to (1.0.0-rc.1 < 1.0.0).
 *  Throws on input that is not MAJOR.MINOR.PATCH[-pre][+build]. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va) throw new Error(`not a version: ${a}`);
  if (!vb) throw new Error(`not a version: ${b}`);
  for (let i = 0; i < 3; i++) {
    const diff = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return comparePre(va.pre, vb.pre);
}

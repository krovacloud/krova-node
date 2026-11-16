// OpenAPI drift gate for @krovacloud/sdk.
//
// `packages/sdk/openapi.json` is a SNAPSHOT of the spec krova-cloud serves at
// /api/v1/openapi.json, and `packages/sdk/src/generated/types.ts` is generated
// from that snapshot by `pnpm --filter @krovacloud/sdk gen`. Nothing in the API
// repo pushes the spec here, so the snapshot only moves when a human remembers
// to copy it — and for a long stretch nobody did. The published SDK ended up
// declaring `TcpMapping.host` required when the live API does not send it,
// which typechecks clean in every consumer and then hands them `undefined`.
//
// This script is what makes that impossible to miss again: fetch the live spec,
// normalise both documents the same way, and refuse to pass when they differ.
//
//   node scripts/check-openapi-drift.mjs            check, exit 1 on drift
//   node scripts/check-openapi-drift.mjs --write     refresh the snapshot
//
// Exit codes are distinct on purpose. A green run must mean "verified against
// the live spec", never "could not reach it" — a fail-open check here is how
// the drift stayed invisible through 149 lines of divergence.
//
//   0  snapshot matches the live spec (or --write refreshed it)
//   1  drift: the documents differ
//   2  could not reach or parse the live spec — NOT a drift verdict
//
// Override the origin with KROVA_API_BASE when checking against a preview
// deployment or a local dev server.
//
// PENDING API CHANGES. An SDK method for an endpoint that krova-cloud has
// merged but not yet deployed needs the NEW spec in the snapshot, and the live
// spec cannot match it until the deploy. `packages/sdk/openapi-pending.json`
// lists JSON Pointers (RFC 6901) into the spec that are allowed to differ for
// that window: the check removes them from BOTH documents before comparing, so
// everything else is still held to byte equality, and it says out loud which
// pointers it skipped. Once the deploy lands the pointers hold equal values on
// both sides, the check reports them as "now live", and the file is emptied.
// The file ships empty (`"ignore": []`) so the default stays strict.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.KROVA_API_BASE ?? "https://krova.cloud").replace(/\/+$/, "");
const SPEC_URL = `${BASE}/api/v1/openapi.json`;
const SNAPSHOT = join("packages", "sdk", "openapi.json");
const PENDING = join("packages", "sdk", "openapi-pending.json");
const WRITE = process.argv.includes("--write");

// ── normalisation ────────────────────────────────────────────────────────────
// Sort object keys so a re-serialisation of the same document is byte-identical.
// Arrays keep their order: `required` order carries no meaning to the generator,
// but `servers` and `parameters` order does, and one canonical form for both is
// simpler than a per-key rule.
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
};

const serialise = (doc) => `${JSON.stringify(sortKeys(doc), null, 2)}\n`;

// ── pending pointers ─────────────────────────────────────────────────────────
const parsePointer = (pointer) => {
  if (pointer === "" || pointer[0] !== "/") {
    console.error(`${PENDING}: "${pointer}" is not a JSON Pointer (must start with "/").`);
    process.exit(2);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
};

const getAt = (doc, keys) => {
  let node = doc;
  for (const key of keys) {
    if (node === null || typeof node !== "object" || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
};

// Returns a deep copy of `doc` without the value at each pointer. A pointer
// whose parent is missing is skipped: the pending entry may name something
// only one side has, which is the whole point.
const withoutPointers = (doc, pointers) => {
  const copy = structuredClone(doc);
  for (const pointer of pointers) {
    const keys = parsePointer(pointer);
    const parent = getAt(copy, keys.slice(0, -1));
    if (parent !== null && typeof parent === "object") delete parent[keys[keys.length - 1]];
  }
  return copy;
};

let pending = [];
try {
  const parsed = JSON.parse(readFileSync(PENDING, "utf8"));
  if (!Array.isArray(parsed.ignore) || !parsed.ignore.every((p) => typeof p === "string")) {
    console.error(`${PENDING}: "ignore" must be an array of JSON Pointer strings.`);
    process.exit(2);
  }
  pending = parsed.ignore;
} catch (err) {
  if (err.code !== "ENOENT") {
    console.error(`Could not read ${PENDING}: ${err.message}`);
    process.exit(2);
  }
}

// ── fetch the live spec ──────────────────────────────────────────────────────
const fail = (code, message) => {
  console.error(message);
  process.exit(code);
};

let live;
try {
  const res = await fetch(SPEC_URL, { headers: { accept: "application/json" } });
  if (!res.ok) fail(2, `Could not fetch ${SPEC_URL}: HTTP ${res.status} ${res.statusText}`);
  live = await res.json();
} catch (err) {
  fail(2, `Could not fetch ${SPEC_URL}: ${err.message}`);
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

const fullLiveText = serialise(live);
const fullSnapshotText = serialise(snapshot);

if (WRITE) {
  writeFileSync(SNAPSHOT, fullLiveText);
  const verb = fullLiveText === fullSnapshotText ? "already current" : "updated";
  console.log(`${SNAPSHOT} ${verb} from ${SPEC_URL}`);
  if (pending.length) console.log(`The snapshot now equals the live spec, so empty "ignore" in ${PENDING}.`);
  console.log("Now run:  pnpm --filter @krovacloud/sdk gen");
  process.exit(0);
}

// Compare with the pending pointers removed from both sides.
const liveDoc = withoutPointers(live, pending);
const snapshotDoc = withoutPointers(snapshot, pending);
const liveText = serialise(liveDoc);
const snapshotText = serialise(snapshotDoc);

if (liveText === snapshotText) {
  const skipped = pending.filter(
    (pointer) => !(serialise(getAt(live, parsePointer(pointer))) === serialise(getAt(snapshot, parsePointer(pointer)))),
  );
  const nowLive = pending.filter((pointer) => !skipped.includes(pointer));
  console.log(`${SNAPSHOT} matches ${SPEC_URL}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} pending pointer(s) the live API does not serve yet (${PENDING}):`);
    for (const pointer of skipped) console.log(`  ${pointer}`);
    console.log("Those parts were NOT verified against the live API.");
  }
  if (nowLive.length) {
    console.log(`These pending pointer(s) are live now; remove them from ${PENDING}:`);
    for (const pointer of nowLive) console.log(`  ${pointer}`);
  }
  process.exit(0);
}

// ── report ───────────────────────────────────────────────────────────────────
// A 149-line raw diff tells you nothing at a glance. Lead with the differences
// that change a generated TYPE — added/removed operations and schemas, and any
// `required` set that moved — then give the raw line count as a tail number.
const keys = (obj) => Object.keys(obj ?? {}).sort();
const only = (a, b) => a.filter((k) => !b.includes(k));

const requiredSets = (doc) => {
  const found = new Map();
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${path}[${i}]`);
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "required" && Array.isArray(v) && v.every((e) => typeof e === "string")) {
        found.set(path || ".", [...v].sort().join(", "));
      } else {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(doc, "");
  return found;
};

const report = [];

const addedPaths = only(keys(liveDoc.paths), keys(snapshotDoc.paths));
const removedPaths = only(keys(snapshotDoc.paths), keys(liveDoc.paths));
if (addedPaths.length) report.push(`  new operations not in the snapshot: ${addedPaths.join(", ")}`);
if (removedPaths.length) report.push(`  operations the API no longer serves: ${removedPaths.join(", ")}`);

const liveSchemas = keys(liveDoc.components?.schemas);
const snapSchemas = keys(snapshotDoc.components?.schemas);
const addedSchemas = only(liveSchemas, snapSchemas);
const removedSchemas = only(snapSchemas, liveSchemas);
if (addedSchemas.length) report.push(`  new schemas: ${addedSchemas.join(", ")}`);
if (removedSchemas.length) report.push(`  dropped schemas: ${removedSchemas.join(", ")}`);

const liveRequired = requiredSets(liveDoc);
const snapRequired = requiredSets(snapshotDoc);
for (const [path, liveValue] of liveRequired) {
  const snapValue = snapRequired.get(path);
  if (snapValue === liveValue) continue;
  report.push(`  required set changed at ${path}`);
  report.push(`      live: ${liveValue}`);
  report.push(`      snapshot: ${snapValue ?? "(absent)"}`);
}
for (const [path] of snapRequired) {
  if (!liveRequired.has(path)) report.push(`  required set only in the snapshot: ${path}`);
}

// Count lines present in one document but not the other. A positional
// comparison would mis-report every line after an insertion as "changed"; a
// multiset difference gives a number that means something.
const lineCounts = (text) => {
  const counts = new Map();
  for (const line of text.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};
const liveLines = lineCounts(liveText);
const snapshotLines = lineCounts(snapshotText);
let changedLines = 0;
for (const line of new Set([...liveLines.keys(), ...snapshotLines.keys()])) {
  changedLines += Math.abs((liveLines.get(line) ?? 0) - (snapshotLines.get(line) ?? 0));
}

console.error(`DRIFT: ${SNAPSHOT} no longer matches ${SPEC_URL}`);
console.error("");
if (report.length) {
  console.error("Type-affecting differences:");
  for (const line of report) console.error(line);
  console.error("");
}
console.error(`${changedLines} normalised line(s) differ in total.`);
console.error("");
console.error("Refresh with:");
console.error("  node scripts/check-openapi-drift.mjs --write");
console.error("  pnpm --filter @krovacloud/sdk gen");
console.error("");
console.error(`If the snapshot is deliberately ahead of the live API (an SDK method for an endpoint that is merged but not deployed), list those spec pointers in "ignore" in ${PENDING}.`);
process.exit(1);

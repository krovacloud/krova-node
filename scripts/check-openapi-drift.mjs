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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.KROVA_API_BASE ?? "https://krova.cloud").replace(/\/+$/, "");
const SPEC_URL = `${BASE}/api/v1/openapi.json`;
const SNAPSHOT = join("packages", "sdk", "openapi.json");
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

const liveText = serialise(live);
const snapshotText = serialise(snapshot);

if (WRITE) {
  writeFileSync(SNAPSHOT, liveText);
  const verb = liveText === snapshotText ? "already current" : "updated";
  console.log(`${SNAPSHOT} ${verb} from ${SPEC_URL}`);
  console.log("Now run:  pnpm --filter @krovacloud/sdk gen");
  process.exit(0);
}

if (liveText === snapshotText) {
  console.log(`${SNAPSHOT} matches ${SPEC_URL}`);
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

const addedPaths = only(keys(live.paths), keys(snapshot.paths));
const removedPaths = only(keys(snapshot.paths), keys(live.paths));
if (addedPaths.length) report.push(`  new operations not in the snapshot: ${addedPaths.join(", ")}`);
if (removedPaths.length) report.push(`  operations the API no longer serves: ${removedPaths.join(", ")}`);

const liveSchemas = keys(live.components?.schemas);
const snapSchemas = keys(snapshot.components?.schemas);
const addedSchemas = only(liveSchemas, snapSchemas);
const removedSchemas = only(snapSchemas, liveSchemas);
if (addedSchemas.length) report.push(`  new schemas: ${addedSchemas.join(", ")}`);
if (removedSchemas.length) report.push(`  dropped schemas: ${removedSchemas.join(", ")}`);

const liveRequired = requiredSets(live);
const snapRequired = requiredSets(snapshot);
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
process.exit(1);

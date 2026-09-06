// Publish the MCP server to the official registry at registry.modelcontextprotocol.io.
//
// ⛔ THE VERSION IS DERIVED FROM npm, NEVER READ FROM THE COMMITTED FILE.
//
// That is the whole point of this script. `server.json` carries a version
// field, and the obvious thing — publish whatever it says — silently rots:
//
//   * `scripts/release.mjs` computes each release's version by patch-bumping
//     npm's latest, so the number never comes from the repo in the first place.
//   * CI never commits that bump back to main.
//   * `server.json` is not in the package's `files` list, so it does not ship
//     inside the tarball either.
//
// The result, observed on 2026-09-05: the registry advertised 0.3.5 while npm
// served 0.3.6, within an hour of publishing. Nothing errored. The registry
// only validates that the declared version EXISTS on npm carrying the
// `mcpName` marker — not that it is the latest — so a stale entry is a silent,
// permanent lie about which version users get.
//
// Deriving the version at publish time makes that class of drift impossible:
// there is no stored number to go stale.
//
// Usage:
//   node scripts/publish-mcp-registry.mjs [--dry-run]
//
// Prerequisites (both the owner's, not this script's):
//   * `mcp-publisher` on PATH        — brew install mcp-publisher
//   * an authenticated session       — mcp-publisher login dns --domain krova.cloud …

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DRY = process.argv.includes("--dry-run");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_JSON = join(ROOT, "packages/mcp/server.json");

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (!existsSync(SERVER_JSON)) {
  die(`no server.json at ${SERVER_JSON}`);
}

const server = JSON.parse(readFileSync(SERVER_JSON, "utf8"));
const pkg = (server.packages ?? []).find((p) => p.registryType === "npm");
if (!pkg) {
  die("server.json declares no npm package — nothing to derive a version from");
}

const identifier = pkg.identifier;
console.log(`▸ server   : ${server.name}`);
console.log(`▸ package  : ${identifier}`);

// ── The version, straight from npm ──────────────────────────────────────────
//
// ⛔ POLLED, NOT READ ONCE. This script runs immediately after `release.mjs`
// publishes, and npm is read-after-write eventual: the first read routinely
// returns the PREVIOUS version. That is not theoretical — on 2026-09-06
// release.mjs published 0.3.9 at 05:29:43 and this step, moments later, read
// 0.3.8 and published *that* to the registry. The entry then advertised a
// version older than npm's, which is the exact drift the automation exists to
// prevent, reintroduced by the automation itself.
//
// `release.mjs` writes the version it just published into package.json, so the
// local manifest is the floor npm has to reach. When nothing was released this
// run the local version is already <= npm's and the first read passes.
const localVersion = JSON.parse(
  readFileSync(join(ROOT, "packages/mcp/package.json"), "utf8")
).version;

const cmpSemver = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};

const readNpm = () => {
  try {
    return JSON.parse(
      execSync(`npm view ${identifier} --json`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString()
    );
  } catch {
    return null;
  }
};

const ATTEMPTS = 12;
const WAIT_MS = 5000;
let manifest = null;
let latest = null;

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  manifest = readNpm();
  latest = manifest?.["dist-tags"]?.latest ?? manifest?.version ?? null;
  if (latest && cmpSemver(latest, localVersion) >= 0) break;

  if (attempt === ATTEMPTS) {
    die(
      `npm still serves ${latest ?? "nothing"} for ${identifier} after ` +
        `${(ATTEMPTS * WAIT_MS) / 1000}s, but package.json says ${localVersion}. ` +
        `Publishing now would advertise a version older than npm's. Re-run once ` +
        `npm has caught up.`
    );
  }
  console.log(
    `▸ npm serves ${latest ?? "nothing"}, waiting for >= ${localVersion} (${attempt}/${ATTEMPTS})`
  );
  execSync(`sleep ${WAIT_MS / 1000}`);
}

if (!latest) {
  die(`npm returned no latest version for ${identifier}`);
}

// ⛔ The registry REJECTS a version whose published tarball does not carry an
// `mcpName` matching the server name. Checking here turns a confusing
// "Registry validation failed for package" into a message that says which
// version is wrong and why — and stops us publishing a version that was cut
// before the marker existed (0.3.0 through 0.3.3 are exactly that).
const publishedName = manifest.mcpName;
if (publishedName !== server.name) {
  die(
    `${identifier}@${latest} declares mcpName ${JSON.stringify(publishedName ?? null)}, ` +
      `but server.json is named "${server.name}". The registry verifies package ownership ` +
      `through that field, so publishing would be rejected. Republish the package with a ` +
      `matching mcpName before running this.`
  );
}

console.log(`▸ npm latest: ${latest} (mcpName verified)`);

// ── Write it, only if it actually moved ─────────────────────────────────────
const stale = server.version !== latest || pkg.version !== latest;
if (stale) {
  console.log(`▸ syncing server.json: ${server.version} → ${latest}`);
  server.version = latest;
  for (const p of server.packages ?? []) {
    if (p.identifier === identifier) p.version = latest;
  }
  if (!DRY) {
    writeFileSync(SERVER_JSON, `${JSON.stringify(server, null, 2)}\n`);
  }
} else {
  console.log("▸ server.json already matches npm");
}

// ── Already published? Then this is a no-op ─────────────────────────────────
// ⛔ Required for running on EVERY release. `release.mjs` only republishes
// packages that changed, so most runs leave the MCP package untouched and npm's
// latest is already in the registry. Without this the step would try to publish
// a version the registry already holds and fail the release for no reason.
let alreadyLive = false;
try {
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(server.name.split("/")[0])}`;
  const res = await fetch(url);
  if (res.ok) {
    const body = await res.json();
    alreadyLive = (body.servers ?? []).some((entry) => {
      const detail = entry.server ?? entry;
      const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
      return detail.name === server.name && detail.version === latest && meta?.isLatest;
    });
  }
} catch {
  // A registry read failure is not a reason to skip — fall through and let
  // publish decide. Worst case it reports the version already exists.
}

if (alreadyLive) {
  console.log(`▸ registry already serves ${latest} as latest — nothing to do`);
  process.exit(0);
}

if (DRY) {
  console.log("\n(dry run — nothing written, nothing published)");
  process.exit(0);
}

// ── Validate, then publish ──────────────────────────────────────────────────
// CI downloads the binary into the workspace rather than onto PATH.
const PUBLISHER = process.env.MCP_PUBLISHER_BIN || "mcp-publisher";

const run = (args) =>
  execFileSync(PUBLISHER, args, {
    cwd: join(ROOT, "packages/mcp"),
    stdio: "inherit",
  });

try {
  run(["validate"]);
  run(["publish"]);
} catch {
  die(
    "mcp-publisher failed. If it is not installed: `brew install mcp-publisher`. " +
      "If the error mentions an expired or missing token, re-authenticate: " +
      "`mcp-publisher login dns --domain krova.cloud --private-key <key>`."
  );
}

console.log(
  `\n✓ published ${server.name} ${latest}\n` +
    `  verify: curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=${server.name}"\n` +
    `  ⚠️ commit the server.json version change so the repo matches what is live.`
);

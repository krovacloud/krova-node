import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `src/generated/types.ts` is produced from `openapi.json` by `pnpm gen`. Both
 * are committed, and nothing has ever checked that they agree — so refreshing
 * the spec without re-running the generator leaves the published types
 * describing the PREVIOUS shape of the API, silently and with a green build.
 *
 * This is the offline half of the drift gate. `scripts/check-openapi-drift.mjs`
 * proves the snapshot matches the live API and needs the network; this proves
 * the checked-in types match the checked-in snapshot and needs nothing. Run the
 * generator, diff against the committed file, fail on any difference.
 */
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(PKG, "node_modules", ".bin", "openapi-typescript");
const SPEC = join(PKG, "openapi.json");
const COMMITTED = join(PKG, "src", "generated", "types.ts");

const workdir = mkdtempSync(join(tmpdir(), "krova-sdk-types-"));

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test("src/generated/types.ts is what openapi.json generates", () => {
  const regenerated = join(workdir, "types.ts");

  // Same invocation as the package's `gen` script, writing somewhere throwaway
  // so a failing run never half-rewrites the committed file.
  execFileSync(GENERATOR, [SPEC, "-o", regenerated], { stdio: "pipe" });

  assert.equal(
    readFileSync(regenerated, "utf8"),
    readFileSync(COMMITTED, "utf8"),
    "openapi.json and src/generated/types.ts disagree — run `pnpm --filter @krovacloud/sdk gen` and commit the result",
  );
});

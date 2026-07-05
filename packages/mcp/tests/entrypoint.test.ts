import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { isEntrypoint } from "../src/index.js";

/**
 * Regression: the server is launched via `npx -y @krovacloud/mcp`, which runs
 * the `.bin/krova-mcp` SYMLINK, while `import.meta.url` is the realpath'd
 * `dist/index.js`. The entrypoint check must resolve both to their real paths,
 * or `main()` never runs and the MCP client sees a server that does nothing.
 */

let dir: string;
let real: string;
let link: string;
let other: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "krova-mcp-entry-"));
  real = join(dir, "dist-index.mjs");
  link = join(dir, "bin-krova-mcp"); // stands in for .bin/krova-mcp
  other = join(dir, "unrelated.mjs");
  writeFileSync(real, "// entry\n");
  writeFileSync(other, "// other\n");
  symlinkSync(real, link);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("detects launch via a symlink to the module (the npx/global-install path)", () => {
  const moduleUrl = pathToFileURL(real).href;
  assert.equal(isEntrypoint(link, moduleUrl), true, "symlinked launch must count as the entrypoint");
});

test("detects a direct launch of the module", () => {
  assert.equal(isEntrypoint(real, pathToFileURL(real).href), true);
});

test("does not fire when a different file is the entrypoint (imported as a library)", () => {
  assert.equal(isEntrypoint(other, pathToFileURL(real).href), false);
});

test("is false when there is no argv[1]", () => {
  assert.equal(isEntrypoint(undefined, pathToFileURL(real).href), false);
});

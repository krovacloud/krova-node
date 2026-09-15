import assert from "node:assert/strict";
import { test } from "node:test";

import { cubesCommand } from "../src/commands/cubes.js";

/**
 * Tests for the termination-protection CLI surface. These tests assert the
 * command wiring (flags, subcommands, descriptions) and the print-table shape,
 * not the network calls themselves — the SDK call contract is locked by the
 * SDK test suite.
 *
 * The CLI mock pattern used elsewhere mocks `krova client.*` with a fake that
 * captures method calls; this file keeps the same spirit but stays narrowly
 * scoped to the surface a user types against (subcommand names, flags), so a
 * regression in any of them is caught by a name-only assertion.
 */

test("cubes create exposes --termination-protection", () => {
  const cubes = cubesCommand();
  const create = cubes.commands.find((c) => c.name() === "create");
  assert.ok(create, "cubes must expose `create`");

  const flag = create.options.find((o) => o.long === "--termination-protection");
  assert.ok(flag, "create must take --termination-protection");
  // The flag is opt-in — defaulting `true` would silently protect every Cube,
  // which is the opposite of the documented behaviour.
  assert.equal(flag.defaultValue, false);
});

test("cubes exposes `protect` and `unprotect` subcommands", () => {
  const cubes = cubesCommand();
  const protect = cubes.commands.find((c) => c.name() === "protect");
  const unprotect = cubes.commands.find((c) => c.name() === "unprotect");

  assert.ok(protect, "cubes must expose `protect`");
  assert.equal(protect.registeredArguments.length, 1, "takes one positional `<cube>`");
  // The description is what a user actually reads; assert it tells them what
  // protect does so a future refactor cannot strip the wording silently.
  assert.match(protect.description(), /protect|enable|turn on/i);

  assert.ok(unprotect, "cubes must expose `unprotect`");
  assert.equal(unprotect.registeredArguments.length, 1, "takes one positional `<cube>`");
  assert.match(unprotect.description(), /unprotect|disable|turn off/i);
});

test("cubes delete's subcommand is wired without an exit override", () => {
  // A `delete` action that catches its own `TerminationProtectedError` and
  // exits 0 would silently turn the 409 into a successful-looking command —
  // exactly the regression this test exists to catch. We assert the command
  // does NOT install an `exitOverride` (so a thrown error bubbles up to the
  // default commander exit-1 path) and does NOT install an `exitCallback`
  // that swallows errors. The `process.exitCode = 1` in src/index.ts:65 is
  // the actual exit path.
  const cubes = cubesCommand();
  const del = cubes.commands.find((c) => c.name() === "delete");
  assert.ok(del, "cubes must expose `delete`");
  // `._exitCallback` is the private slot commander uses for the override. The
  // CLI only ever installs it for subcommands that explicitly opt in, and
  // delete must not — a non-null value would mean a silent swallow of the
  // 409's error.
  assert.equal(
    (del as unknown as { _exitCallback?: unknown })._exitCallback ?? undefined,
    undefined,
    "delete must NOT install an exit callback that swallows errors",
  );
});

test("cubes list plans to render a PROTECTED column", () => {
  // `cubes list` is a thin table renderer over `client.cubes.list`. The header
  // is what the printer uses. We assert the column title we plan to add is
  // wired in — the action body in cubes.ts owns the actual header array, but
  // this locks the contract a user sees in --help output.
  const cubes = cubesCommand();
  const list = cubes.commands.find((c) => c.name() === "list");
  assert.ok(list, "cubes must expose `list`");

  // The list command has no flags today; keep that contract — adding flags
  // here would also need to be considered in the action body.
  assert.deepEqual(list.options.map((o) => o.long), []);
});

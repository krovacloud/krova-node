import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertEnvName,
  buildCommand,
  connectSsh,
  HostKeyMismatchError,
  hostKeyFingerprint,
  hostKeyMatches,
  shellQuote,
} from "../src/ssh.js";

test("shellQuote wraps plain, spaced and empty strings", () => {
  assert.equal(shellQuote("abc"), "'abc'");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote(""), "''");
});

test("shellQuote neutralizes quotes, substitutions and newlines", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("''"), `''\\'''\\'''`);
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(shellQuote("`id`; echo $HOME"), "'`id`; echo $HOME'");
  assert.equal(shellQuote("a\nb"), "'a\nb'");
});

test("shellQuote refuses a NUL byte", () => {
  assert.throws(() => shellQuote("a\0b"), TypeError);
});

test("env names are validated", () => {
  assertEnvName("FOO");
  assertEnvName("_a1");
  for (const bad of ["", "1A", "A-B", "A B", "A=B", "A;rm", "$(x)"]) {
    assert.throws(() => assertEnvName(bad), TypeError, bad);
  }
});

test("buildCommand: a string runs as written, an array is quoted", () => {
  assert.equal(buildCommand("ls -la | wc -l"), "ls -la | wc -l");
  assert.equal(buildCommand(["echo", "a b", "it's"]), `'echo' 'a b' 'it'\\''s'`);
});

test("buildCommand: cwd and env are quoted and applied to the whole command", () => {
  assert.equal(
    buildCommand(["pwd"], { cwd: "/tmp/a b", env: { FOO: "x y" } }),
    `cd -- '/tmp/a b' && export FOO='x y' && 'pwd'`,
  );
  assert.equal(buildCommand("a; b", { cwd: "/x" }), "cd -- '/x' && {\na; b\n}");
  assert.throws(() => buildCommand("true", { env: { "A;B": "1" } }), TypeError);
  assert.ok(buildCommand("x", { cwd: "-P" }).includes("cd -- '-P'"));
  assert.throws(() => buildCommand("x", { cwd: "" }), TypeError);
  assert.throws(() => buildCommand("  "), TypeError);
});

const blobA = Buffer.from("host key A blob");
const blobB = Buffer.from("host key B blob");
const pin = (blob: Buffer) => ({ type: "ssh-ed25519", key: blob.toString("base64") });

test("hostKeyMatches compares the decoded blob byte for byte", () => {
  assert.equal(hostKeyMatches(blobA, [pin(blobB), pin(blobA)]), true);
  assert.equal(hostKeyMatches(new Uint8Array(blobA), [pin(blobA)]), true);
  assert.equal(hostKeyMatches(blobA, [pin(blobB)]), false);
});

test("hostKeyMatches fails closed", () => {
  assert.equal(hostKeyMatches(blobA, []), false);
  assert.equal(hostKeyMatches(new Uint8Array(), [{ type: "ssh-ed25519", key: "" }]), false);
  assert.equal(hostKeyMatches(blobA, [{ type: "ssh-ed25519", key: "not base64 !!" }]), false);
  // A truncated or extended blob is not a match.
  assert.equal(hostKeyMatches(blobA.subarray(0, 5), [pin(blobA)]), false);
  assert.equal(hostKeyMatches(Buffer.concat([blobA, Buffer.from("x")]), [pin(blobA)]), false);
});

test("hostKeyFingerprint looks like ssh-keygen output", () => {
  assert.match(hostKeyFingerprint(blobA), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("connectSsh refuses without pinned host keys, before any network", async () => {
  await assert.rejects(
    connectSsh({ host: "203.0.113.1", username: "root", privateKey: "x", hostKeys: [] }),
    HostKeyMismatchError,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { browserSpawnPlan, displayURL, safeBrowserURL, stripControlChars } from "../src/commands/login.js";

const GOOD = "https://krova.cloud/cli?code=ABCD-1234";

test("a normal https verification URL passes unchanged on every platform", () => {
  for (const p of ["win32", "darwin", "linux"] as const) {
    assert.equal(safeBrowserURL(GOOD, p), GOOD);
  }
  assert.equal(safeBrowserURL("https://krova.cloud/cli", "win32"), "https://krova.cloud/cli");
});

test("the returned value is the normalized href", () => {
  assert.equal(
    safeBrowserURL("HTTPS://Krova.Cloud/cli?code=AB CD", "linux"),
    "https://krova.cloud/cli?code=AB%20CD"
  );
});

test("a URL that smuggles a cmd.exe operator is rejected", () => {
  const bad = [
    "https://krova.cloud/cli?code=1&calc.exe",
    "https://krova.cloud/cli?code=1&&calc.exe",
    "https://krova.cloud/cli?code=1|calc.exe",
    "https://krova.cloud/cli?code=1^2",
    "https://krova.cloud/cli&calc.exe",
    "https://krova.cloud&calc.exe/cli",
  ];
  for (const u of bad) {
    assert.equal(safeBrowserURL(u, "win32"), null, u);
    assert.equal(safeBrowserURL(u, "linux"), null, u);
  }
});

test("< > and a double quote are percent-encoded by URL parsing, and Windows then rejects the %", () => {
  for (const u of ['https://krova.cloud/cli?code=1>out', "https://krova.cloud/cli?code=1<in", 'https://krova.cloud/cli?code=1"x']) {
    assert.equal(safeBrowserURL(u, "win32"), null, u);
    const href = safeBrowserURL(u, "linux");
    assert.ok(href && !/[<>"]/.test(href), u);
  }
});

test("percent signs are rejected on Windows only", () => {
  const u = "https://krova.cloud/cli?code=%PATH%";
  assert.equal(safeBrowserURL(u, "win32"), null);
  assert.equal(safeBrowserURL(u, "linux"), u);
  assert.equal(safeBrowserURL(u, "darwin"), u);
});

test("scheme checks still apply", () => {
  assert.equal(safeBrowserURL("javascript:alert(1)", "linux"), null);
  assert.equal(safeBrowserURL("file:///etc/passwd", "linux"), null);
  assert.equal(safeBrowserURL("http://example.com/cli", "linux"), null);
  assert.equal(safeBrowserURL("not a url", "linux"), null);
  assert.equal(
    safeBrowserURL("http://localhost:3000/cli?code=A-1", "linux"),
    "http://localhost:3000/cli?code=A-1"
  );
  assert.equal(safeBrowserURL("http://127.0.0.1:3000/cli", "linux"), "http://127.0.0.1:3000/cli");
  assert.equal(
    safeBrowserURL("http://[::1]:3000/cli?code=A-1", "linux"),
    "http://[::1]:3000/cli?code=A-1"
  );
});

test("the win32 spawn plan uses rundll32 and never a shell", () => {
  const plan = browserSpawnPlan(GOOD, "win32");
  assert.equal(plan.command, "rundll32");
  assert.deepEqual(plan.args, ["url.dll,FileProtocolHandler", GOOD]);
  assert.ok(!("shell" in plan.options));
  assert.equal(plan.options.windowsHide, true);
});

test("the macOS and Linux plans keep open and xdg-open, with no shell", () => {
  const mac = browserSpawnPlan(GOOD, "darwin");
  assert.deepEqual([mac.command, mac.args], ["open", [GOOD]]);
  const lin = browserSpawnPlan(GOOD, "linux");
  assert.deepEqual([lin.command, lin.args], ["xdg-open", [GOOD]]);
  for (const p of [mac, lin]) assert.ok(!("shell" in p.options));
});

test("displayURL strips control characters, including ESC", () => {
  assert.equal(stripControlChars("a\u001b[31mb\u0007c\u009bd\u007fe"), "a[31mbcde");
  // Does not parse as a URL: the raw string is shown with the controls removed.
  assert.equal(displayURL("not a url\u001b[2J"), "not a url[2J");
  // Parses: the normalized href is shown and carries no control character.
  const shown = displayURL("https://krova.cloud/cli?code=1\u001b[2J&calc.exe");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(shown));
  assert.ok(shown.startsWith("https://krova.cloud/cli?code=1"));
  assert.equal(displayURL(GOOD), GOOD);
});

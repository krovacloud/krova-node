import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BASE_URL, KrovaClient } from "../src/index.js";

const VAR = "KROVA_BASE_URL";

/** Run `fn` with `KROVA_BASE_URL` set to `value` (or unset for `undefined`), then restore it. */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  }
}

const make = (baseUrl?: string) =>
  new KrovaClient({ apiKey: "kro_test", ...(baseUrl === undefined ? {} : { baseUrl }) }).baseUrl;

test("no option and no env falls back to the Krova default", () => {
  assert.equal(
    withEnv(undefined, () => make()),
    DEFAULT_BASE_URL,
  );
});

test("KROVA_BASE_URL is used when no option is given", () => {
  assert.equal(
    withEnv("https://env.test/api/v1", () => make()),
    "https://env.test/api/v1",
  );
});

test("an empty or whitespace KROVA_BASE_URL is treated as unset", () => {
  assert.equal(
    withEnv("", () => make()),
    DEFAULT_BASE_URL,
  );
  assert.equal(
    withEnv("   ", () => make()),
    DEFAULT_BASE_URL,
  );
});

test("the explicit option wins over KROVA_BASE_URL", () => {
  assert.equal(
    withEnv("https://env.test/api/v1", () => make("https://option.test/api/v1")),
    "https://option.test/api/v1",
  );
});

test("an empty or whitespace option is treated as unset (env, then default)", () => {
  assert.equal(
    withEnv("https://env.test/api/v1", () => make("")),
    "https://env.test/api/v1",
  );
  assert.equal(
    withEnv(undefined, () => make("  ")),
    DEFAULT_BASE_URL,
  );
});

test("a bare origin gets /api/v1 appended", () => {
  assert.equal(
    withEnv(undefined, () => make("https://krova.cloud")),
    "https://krova.cloud/api/v1",
  );
  assert.equal(
    withEnv("https://env.test", () => make()),
    "https://env.test/api/v1",
  );
  assert.equal(
    withEnv(undefined, () => make("http://localhost:3007")),
    "http://localhost:3007/api/v1",
  );
});

test("trailing slashes are stripped, and an origin with only slashes is still an origin", () => {
  assert.equal(
    withEnv(undefined, () => make("https://krova.cloud/api/v1/")),
    "https://krova.cloud/api/v1",
  );
  assert.equal(
    withEnv(undefined, () => make("https://krova.cloud/")),
    "https://krova.cloud/api/v1",
  );
  assert.equal(
    withEnv(undefined, () => make("https://krova.cloud///")),
    "https://krova.cloud/api/v1",
  );
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(
    withEnv(undefined, () => make("  https://krova.cloud/api/v1  ")),
    "https://krova.cloud/api/v1",
  );
});

test("any other path is kept as given (gateways)", () => {
  assert.equal(
    withEnv(undefined, () => make("https://gateway.internal/krova/api/v1")),
    "https://gateway.internal/krova/api/v1",
  );
  assert.equal(
    withEnv(undefined, () => make("https://gateway.internal/krova/")),
    "https://gateway.internal/krova",
  );
});

test("a runtime without process falls back to the default without throwing", () => {
  const saved = globalThis.process;
  // biome-ignore lint/suspicious/noExplicitAny: simulating a browser or edge runtime
  (globalThis as any).process = undefined;
  try {
    assert.equal(typeof process, "undefined");
    assert.equal(make(), DEFAULT_BASE_URL);
    assert.equal(make("https://krova.cloud"), "https://krova.cloud/api/v1");
  } finally {
    globalThis.process = saved;
  }
});

test("a runtime whose process has no env falls back to the default", () => {
  const saved = globalThis.process;
  // biome-ignore lint/suspicious/noExplicitAny: simulating an edge runtime shim
  (globalThis as any).process = { versions: {} };
  try {
    assert.equal(make(), DEFAULT_BASE_URL);
  } finally {
    globalThis.process = saved;
  }
});

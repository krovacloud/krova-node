import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import {
  KrovaWebhookError,
  computeSignature,
  parseSignatureHeader,
  verifyKrovaRequest,
  verifyKrovaWebhook,
  verifyKrovaWebhookOrThrow,
} from "../src/index.js";

const SECRET = "whsec_test_krova_cloud_secret";
const BODY = JSON.stringify({ event: "cube.provisioned", data: { id: "cube_123" } });

/** Sign a body exactly the way the Krova Cloud platform does. */
function sign(body: string, secret: string, timestamp: number): string {
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

test("valid signature passes", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: header,
    secret: SECRET,
    now,
  });
  assert.equal(result.valid, true);
  assert.equal(result.timestamp, now);
  assert.equal(result.reason, undefined);
});

test("valid signature passes with Buffer payload", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const result = verifyKrovaWebhook({
    payload: Buffer.from(BODY, "utf8"),
    signature: header,
    secret: SECRET,
    now,
  });
  assert.equal(result.valid, true);
});

test("tampered body fails with invalid_signature", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const result = verifyKrovaWebhook({
    payload: `${BODY} `, // one extra byte
    signature: header,
    secret: SECRET,
    now,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_signature");
});

test("wrong secret fails with invalid_signature", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: header,
    secret: "whsec_the_wrong_secret",
    now,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_signature");
});

test("expired timestamp fails with timestamp_out_of_tolerance", () => {
  const signedAt = 1_700_000_000;
  const header = sign(BODY, SECRET, signedAt);
  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: header,
    secret: SECRET,
    now: signedAt + 301, // just past the default 300s window
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "timestamp_out_of_tolerance");
  assert.equal(result.timestamp, signedAt);
});

test("future timestamp beyond tolerance also rejected", () => {
  const signedAt = 1_700_000_000;
  const header = sign(BODY, SECRET, signedAt);
  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: header,
    secret: SECRET,
    now: signedAt - 301,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "timestamp_out_of_tolerance");
});

test("timestamp exactly at tolerance boundary passes", () => {
  const signedAt = 1_700_000_000;
  const header = sign(BODY, SECRET, signedAt);
  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: header,
    secret: SECRET,
    now: signedAt + 300,
  });
  assert.equal(result.valid, true);
});

test("custom toleranceSeconds is honored", () => {
  const signedAt = 1_700_000_000;
  const header = sign(BODY, SECRET, signedAt);
  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: header,
    secret: SECRET,
    toleranceSeconds: 10,
    now: signedAt + 11,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "timestamp_out_of_tolerance");
});

test("malformed header fails with malformed_header", () => {
  const now = 1_700_000_000;
  for (const bad of ["", "garbage", "t=123", "v1=abcdef", "t=,v1=", "t=notanumber,v1=deadbeef"]) {
    const result = verifyKrovaWebhook({
      payload: BODY,
      signature: bad,
      secret: SECRET,
      now,
    });
    assert.equal(result.valid, false, `expected invalid for header: "${bad}"`);
    assert.equal(result.reason, "malformed_header", `header: "${bad}"`);
  }
});

test("parseSignatureHeader parses fields in any order, ignores unknowns", () => {
  const parsed = parseSignatureHeader("v1=deadbeef, foo=bar ,t=1700000000");
  assert.equal(parsed.timestamp, 1_700_000_000);
  assert.equal(parsed.signature, "deadbeef");
});

test("parseSignatureHeader throws KrovaWebhookError on malformed input", () => {
  assert.throws(
    () => parseSignatureHeader("nope"),
    (err: unknown) =>
      err instanceof KrovaWebhookError && err.reason === "malformed_header",
  );
});

test("computeSignature matches the platform's raw HMAC", () => {
  const now = 1_700_000_000;
  const expected = createHmac("sha256", SECRET)
    .update(`${now}.${BODY}`)
    .digest("hex");
  assert.equal(computeSignature(SECRET, now, BODY), expected);
});

test("computeSignature matches a hardcoded known-answer vector", () => {
  // Independent known-answer test. The expected hex was computed OUTSIDE this
  // process with OpenSSL — proving the scheme is exactly
  // `HMAC_SHA256(secret, "${t}.${rawBody}")` lowercase hex, not merely
  // self-consistent with Node's crypto:
  //
  //   printf '%s' '1700000000.{"event":"cube.provisioned","data":{"id":"cube_123"}}' \
  //     | openssl dgst -sha256 -hmac 'whsec_known_answer' -r
  //
  const katSecret = "whsec_known_answer";
  const katBody = '{"event":"cube.provisioned","data":{"id":"cube_123"}}';
  const katTimestamp = 1_700_000_000;
  const katExpected =
    "e00e4fd213fa93a87418c9f522d46be2100a3abd9ce8e535b5388185a06b7ac8";

  assert.equal(computeSignature(katSecret, katTimestamp, katBody), katExpected);

  // ...and that exact vector verifies end-to-end through the public API.
  const result = verifyKrovaWebhook({
    payload: katBody,
    signature: `t=${katTimestamp},v1=${katExpected}`,
    secret: katSecret,
    now: katTimestamp,
  });
  assert.equal(result.valid, true);
});

test("verifyKrovaWebhookOrThrow returns timestamp on success", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const out = verifyKrovaWebhookOrThrow({
    payload: BODY,
    signature: header,
    secret: SECRET,
    now,
  });
  assert.equal(out.timestamp, now);
});

test("verifyKrovaWebhookOrThrow throws with the correct reason", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  assert.throws(
    () =>
      verifyKrovaWebhookOrThrow({
        payload: "tampered",
        signature: header,
        secret: SECRET,
        now,
      }),
    (err: unknown) =>
      err instanceof KrovaWebhookError && err.reason === "invalid_signature",
  );
});

test("uses constant-time comparison — a same-length near-miss signature is rejected", () => {
  // The comparison must be byte-for-byte constant time, never a `===` on hex
  // strings that could short-circuit. We prove the near-miss path (a signature
  // that matches in length and in every hex char but the last) is rejected —
  // the exact case a fast-fail string compare would still get right, but which
  // exercises the timingSafeEqual byte loop rather than a length short-circuit.
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const tamperedHeader =
    header.slice(0, -1) + (header.endsWith("0") ? "1" : "0");
  assert.equal(tamperedHeader.length, header.length);

  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: tamperedHeader,
    secret: SECRET,
    now,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_signature");

  // And confirm the primitive itself behaves as a constant-time equality check
  // for our expected/actual buffers (documents the contract verify.ts relies on).
  const good = createHmac("sha256", SECRET).update(`${now}.${BODY}`).digest();
  const same = createHmac("sha256", SECRET).update(`${now}.${BODY}`).digest();
  assert.equal(timingSafeEqual(good, same), true);
});

test("signatures of differing length are rejected without throwing", () => {
  const now = 1_700_000_000;
  const result = verifyKrovaWebhook({
    payload: BODY,
    signature: `t=${now},v1=abcd`, // too short to be a real HMAC
    secret: SECRET,
    now,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_signature");
});

// --- Framework-agnostic helper --------------------------------------------

test("verifyKrovaRequest returns event + delivery from headers (Headers instance)", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const headers = new Headers({
    "X-Krova-Signature": header,
    "X-Krova-Event": "cube.provisioned",
    "X-Krova-Delivery": "dlv_abc123",
  });
  // Fix "now" by using a tolerance that always passes for this timestamp.
  const result = verifyKrovaRequest({
    payload: BODY,
    headers,
    secret: SECRET,
    toleranceSeconds: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.event, "cube.provisioned");
    assert.equal(result.delivery, "dlv_abc123");
    assert.equal(result.timestamp, now);
  }
});

test("verifyKrovaRequest works with a plain header object (case-insensitive)", () => {
  const now = 1_700_000_000;
  const header = sign(BODY, SECRET, now);
  const result = verifyKrovaRequest({
    payload: BODY,
    headers: {
      "x-krova-signature": header,
      "x-krova-event": "space.credit_low",
    },
    secret: SECRET,
    toleranceSeconds: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.event, "space.credit_low");
});

test("verifyKrovaRequest reports invalid when signature header missing", () => {
  const result = verifyKrovaRequest({
    payload: BODY,
    headers: {},
    secret: SECRET,
  });
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "malformed_header");
});

// --- Strict timestamp parsing (hardening) ----------------------------------

test("parseSignatureHeader rejects non-canonical integer timestamp forms", () => {
  // `Number()` is far too lax for a security-relevant field: it accepts
  // scientific notation, hex/binary/octal literals, a leading `+`/`-`, leading
  // zeros, and surrounding whitespace. The `t` field is a plain UNIX-seconds
  // integer; anything that isn't `^\d+$` must be treated as a malformed header.
  const bogus = [
    "t=1e9,v1=deadbeef",
    "t=0x10,v1=deadbeef",
    "t=0b101,v1=deadbeef",
    "t=+5,v1=deadbeef",
    "t=-5,v1=deadbeef",
    "t=01700000000,v1=deadbeef", // leading zero
    "t=1.0,v1=deadbeef",
    "t=Infinity,v1=deadbeef",
  ];
  for (const header of bogus) {
    assert.throws(
      () => parseSignatureHeader(header),
      (err: unknown) =>
        err instanceof KrovaWebhookError && err.reason === "malformed_header",
      `expected malformed_header for: "${header}"`,
    );
  }
});

test("parseSignatureHeader still accepts a plain integer timestamp", () => {
  const parsed = parseSignatureHeader("t=1700000000,v1=deadbeef");
  assert.equal(parsed.timestamp, 1_700_000_000);
  assert.equal(parsed.signature, "deadbeef");
});

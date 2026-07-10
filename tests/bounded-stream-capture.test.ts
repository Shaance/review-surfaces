import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  BoundedStreamCapture,
  COMMAND_RAW_EXCERPT_CAP
} from "../src/commands/bounded-stream-capture";

test("review-surfaces.PRIVACY.2 command capture preserves secret state across explicit Buffer fragments", () => {
  const fragments = [
    Buffer.from("safe "),
    Buffer.from("gh"),
    Buffer.from("p_"),
    Buffer.from("012345678901234567"),
    Buffer.from("890123456789012345"),
    Buffer.from(" tail")
  ];
  const capture = new BoundedStreamCapture(COMMAND_RAW_EXCERPT_CAP);
  for (const fragment of fragments) {
    capture.write(fragment);
  }

  const complete = Buffer.concat(fragments);
  assert.equal(capture.finishAndCheckBlockedSecret(), true);
  assert.equal(
    capture.hash(),
    crypto.createHash("sha256").update(complete).digest("hex"),
    "the digest covers the exact fragmented byte stream"
  );
  const excerpt = capture.redactedExcerpt(COMMAND_RAW_EXCERPT_CAP) ?? "";
  assert.equal(excerpt, "safe [REDACTED:github_token] tail");
  assert.doesNotMatch(excerpt, /ghp_/);
});

test("review-surfaces.PRIVACY.2 command capture scans bytes beyond its retained excerpt cap", () => {
  const cap = 32;
  const fragments = [
    Buffer.from("x".repeat(cap + 20)),
    Buffer.from(" eyJ"),
    Buffer.from("a".repeat(5000)),
    Buffer.from("."),
    Buffer.from("b".repeat(5000)),
    Buffer.from("."),
    Buffer.from("c")
  ];
  const capture = new BoundedStreamCapture(cap);
  for (const fragment of fragments) {
    capture.write(fragment);
  }

  const complete = Buffer.concat(fragments);
  assert.equal(capture.truncated, true);
  assert.equal(capture.finishAndCheckBlockedSecret(), true);
  assert.equal(
    capture.redactedExcerpt(cap),
    "[redacted-blocked]",
    "a blocked stream with no complete retained token must not persist its retained prefix"
  );
  assert.equal(capture.hash(), crypto.createHash("sha256").update(complete).digest("hex"));
});

test("review-surfaces.PRIVACY.2 command capture removes a JWT prefix that crosses its retained raw cap", () => {
  const cap = 64;
  const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(100)}.c`;
  const capture = new BoundedStreamCapture(cap);
  capture.write(Buffer.from(jwt));

  assert.equal(capture.finishAndCheckBlockedSecret(), true);
  const excerpt = capture.redactedExcerpt(cap) ?? "";
  assert.equal(excerpt, "[redacted-blocked]");
  assert.doesNotMatch(excerpt, /eyJ|bbbb/);
  assert.equal(capture.hash(), crypto.createHash("sha256").update(jwt).digest("hex"));
});

test("review-surfaces.PRIVACY.2 an earlier retained secret marker cannot mask a later cross-cap JWT prefix", () => {
  const cap = 96;
  const githubToken = `ghp_${"A".repeat(36)}`;
  const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(100)}.c`;
  const output = `${githubToken} safe ${jwt}`;
  const capture = new BoundedStreamCapture(cap);
  capture.write(Buffer.from(output));

  assert.equal(capture.finishAndCheckBlockedSecret(), true);
  assert.equal(capture.truncated, true);
  const excerpt = capture.redactedExcerpt(cap) ?? "";
  assert.equal(excerpt, "[redacted-blocked]");
  assert.doesNotMatch(excerpt, /REDACTED:github_token|eyJ|bbbb/);
  assert.equal(capture.hash(), crypto.createHash("sha256").update(output).digest("hex"));
});

test("review-surfaces.PRIVACY.2 display bounding does not masquerade as raw capture truncation", () => {
  const githubToken = `ghp_${"A".repeat(36)}`;
  const output = `safe ${githubToken} tail`;
  const capture = new BoundedStreamCapture(256);
  capture.write(Buffer.from(output));

  const bounded = capture.redactedExcerpt(12) ?? "";
  assert.equal(capture.truncated, true, "the first display excerpt is bounded");
  assert.equal(bounded.length, 12);
  assert.equal(
    capture.redactedExcerpt(256),
    "safe [REDACTED:github_token] tail",
    "a later read still knows that the raw capture itself was complete"
  );
});

test("review-surfaces.PRIVACY.2 command capture finalization is explicit, terminal, and idempotent", () => {
  const capture = new BoundedStreamCapture(64);
  capture.write(Buffer.from(`AKIA${"A".repeat(16)}`));

  assert.equal(capture.finishAndCheckBlockedSecret(), true, "stream end supplies the trailing boundary");
  assert.equal(capture.finishAndCheckBlockedSecret(), true, "repeated finalization returns the stored result");
  assert.throws(
    () => capture.write(Buffer.from("Q")),
    /after capture finalization/,
    "a caller cannot accidentally resume a finalized boundary-sensitive stream"
  );
});

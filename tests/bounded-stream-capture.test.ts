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
  assert.equal(capture.redactedExcerpt(cap)?.length, cap);
  assert.equal(capture.finishAndCheckBlockedSecret(), true);
  assert.equal(capture.hash(), crypto.createHash("sha256").update(complete).digest("hex"));
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

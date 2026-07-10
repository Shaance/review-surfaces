"use strict";

const crypto = require("node:crypto");
const {
  StreamingBlockingSecretDetector,
  containsBlockedRedaction,
  redact
} = require("./privacy-runtime.js");

const GENERIC_BLOCKED_SECRET_MARKER = "[redacted-blocked]";

/**
 * Bounded raw-output capture shared by the compiled runner and the no-dist
 * fallback. The digest and secret detector always observe the complete byte
 * stream; only the retained excerpt is capped.
 */
class BoundedStreamCapture {
  constructor(rawExcerptCap) {
    if (!Number.isInteger(rawExcerptCap) || rawExcerptCap <= 0) {
      throw new Error("rawExcerptCap must be a positive integer.");
    }
    this.rawExcerptCap = rawExcerptCap;
    this.digest = crypto.createHash("sha256");
    this.secretDetector = new StreamingBlockingSecretDetector();
    this.chunks = [];
    this.rawLength = 0;
    this.sawContent = false;
    this.finished = false;
    this.secretBlocked = false;
    this.rawTruncated = false;
    this.truncated = false;
  }

  write(chunk) {
    if (this.finished) {
      throw new Error("Cannot write command output after capture finalization.");
    }
    this.sawContent = true;
    this.digest.update(chunk);
    const text = chunk.toString("utf8");
    this.secretDetector.write(text);
    if (this.rawLength >= this.rawExcerptCap) {
      this.rawTruncated = true;
      this.truncated = true;
      return;
    }

    const available = this.rawExcerptCap - this.rawLength;
    const captured = text.slice(0, available);
    this.chunks.push(captured);
    this.rawLength += captured.length;
    if (text.length > available) {
      this.rawTruncated = true;
      this.truncated = true;
    }
  }

  redactedExcerpt(limit) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("excerpt limit must be a positive integer.");
    }
    const rawCaptureTruncated = this.rawTruncated;
    // Excerpt materialization is terminal: the full-stream detector must decide
    // whether retained bytes are safe before any of them can be persisted.
    this.finishAndCheckBlockedSecret();
    if (!this.sawContent) {
      return undefined;
    }
    const redacted = redact(this.chunks.join(""));
    // A token can begin in retained bytes and finish after rawExcerptCap. The
    // streaming detector sees the complete token, while canonical redaction sees
    // only an incomplete prefix. An earlier complete token may also have emitted
    // a marker, so marker presence alone cannot make a truncated capture safe.
    // Preserve precise markers and context only when the raw capture was complete.
    const safeExcerpt = this.secretBlocked &&
      (rawCaptureTruncated || !containsBlockedRedaction(redacted))
      ? GENERIC_BLOCKED_SECRET_MARKER
      : redacted;
    if (safeExcerpt.length <= limit) {
      return safeExcerpt;
    }
    this.truncated = true;
    return safeExcerpt.slice(0, limit);
  }

  /** Finalize pending boundary-sensitive matches. Call once after stream end. */
  finishAndCheckBlockedSecret() {
    if (!this.finished) {
      this.secretBlocked = this.secretDetector.blockedSecretSeen();
      this.finished = true;
    }
    return this.secretBlocked;
  }

  hash() {
    return this.sawContent ? this.digest.copy().digest("hex") : undefined;
  }
}

module.exports = { BoundedStreamCapture };

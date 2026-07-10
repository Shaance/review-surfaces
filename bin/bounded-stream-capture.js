"use strict";

const crypto = require("node:crypto");
const { StreamingBlockingSecretDetector, redact } = require("./privacy-runtime.js");

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
      this.truncated = true;
      return;
    }

    const available = this.rawExcerptCap - this.rawLength;
    const captured = text.slice(0, available);
    this.chunks.push(captured);
    this.rawLength += captured.length;
    if (text.length > available) {
      this.truncated = true;
    }
  }

  redactedExcerpt(limit) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("excerpt limit must be a positive integer.");
    }
    if (!this.sawContent) {
      return undefined;
    }
    const redacted = redact(this.chunks.join(""));
    if (redacted.length <= limit) {
      return redacted;
    }
    this.truncated = true;
    return redacted.slice(0, limit);
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

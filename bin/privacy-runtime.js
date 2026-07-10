"use strict";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixedTokenDefinition(kind, variants, replacement) {
  const sources = [];
  const matchers = [];
  for (const variant of variants) {
    const prefixSource = variant.prefixes.length === 1
      ? escapeRegExp(variant.prefixes[0])
      : `(?:${variant.prefixes.map(escapeRegExp).join("|")})`;
    const quantifier = variant.exactBodyLength
      ? `{${variant.minimumBodyLength}}`
      : `{${variant.minimumBodyLength},}`;
    const canonicalSource =
      `${variant.leadingBoundary ? "\\b" : ""}${prefixSource}${variant.bodySource}${quantifier}` +
      `${variant.trailingBoundary ? "\\b" : ""}`;
    sources.push(canonicalSource);
    // Streaming first recognizes the minimum signature, then retains only
    // bounded state until a real trailing boundary (or stream end) proves the
    // canonical pattern. A chunk boundary is not evidence of a word boundary.
    matchers.push({
      source: `${variant.leadingBoundary ? "\\b" : ""}` +
        `${prefixSource}${variant.bodySource}{${variant.minimumBodyLength}}`,
      maximumLength: Math.max(...variant.prefixes.map((prefix) => prefix.length)) +
        variant.minimumBodyLength,
      bodyPattern: new RegExp(`^(?:${variant.bodySource})$`),
      exactBodyLength: variant.exactBodyLength === true,
      trailingBoundary: variant.trailingBoundary === true
    });
  }
  return {
    kind,
    source: sources.join("|"),
    flags: "g",
    replacement,
    blocked: true,
    streaming: { mode: "bounded", matchers }
  };
}

// Single canonical grammar for redaction, direct block scans, exported parity
// sources, blocked markers, and bounded streaming signatures. Only grammars
// with a genuinely unbounded middle declare specialized cross-chunk state.
const SECRET_PATTERN_DEFINITIONS = [
  {
    kind: "private_key",
    source: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g.source,
    flags: "g",
    replacement: "[REDACTED:private_key]",
    blocked: true,
    streaming: { mode: "pem", prefix: "-----BEGIN " }
  },
  fixedTokenDefinition("aws_access_key_id", [{
    prefixes: ["AKIA"],
    bodySource: "[0-9A-Z]",
    minimumBodyLength: 16,
    exactBodyLength: true,
    leadingBoundary: true,
    trailingBoundary: true
  }], "[REDACTED:aws_access_key_id]"),
  {
    kind: "aws_secret",
    source: /\b(AWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/g.source,
    flags: "g",
    replacement: (_match, prefix) => `${prefix}[REDACTED:aws_secret]`,
    blocked: true,
    streaming: { mode: "aws_secret", prefix: "AWS_SECRET_ACCESS_KEY", leadingBoundary: true }
  },
  fixedTokenDefinition("github_token", [
    {
      prefixes: ["ghp_", "gho_", "ghs_", "ghu_"],
      bodySource: "[A-Za-z0-9]",
      minimumBodyLength: 36,
      leadingBoundary: true,
      trailingBoundary: true
    },
    {
      prefixes: ["github_pat_"],
      bodySource: "[A-Za-z0-9_]",
      minimumBodyLength: 22,
      leadingBoundary: true,
      trailingBoundary: true
    }
  ], "[REDACTED:github_token]"),
  fixedTokenDefinition("slack_token", [{
    prefixes: ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"],
    bodySource: "[A-Za-z0-9-]",
    minimumBodyLength: 10,
    leadingBoundary: true,
    trailingBoundary: true
  }], "[REDACTED:slack_token]"),
  fixedTokenDefinition("openai_key", [{
    prefixes: ["sk-", "sk-proj-"],
    bodySource: "[A-Za-z0-9_-]",
    minimumBodyLength: 20,
    leadingBoundary: true,
    trailingBoundary: true
  }], "[REDACTED:openai_key]"),
  fixedTokenDefinition("stripe_key", [{
    prefixes: ["sk_live_", "rk_live_"],
    bodySource: "[A-Za-z0-9]",
    minimumBodyLength: 20,
    leadingBoundary: true,
    trailingBoundary: true
  }], "[REDACTED:stripe_key]"),
  fixedTokenDefinition("google_oauth_token", [{
    prefixes: ["ya29."],
    bodySource: "[A-Za-z0-9_-]",
    minimumBodyLength: 20,
    leadingBoundary: true,
    trailingBoundary: true
  }], "[REDACTED:google_oauth_token]"),
  {
    kind: "jwt",
    source: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g.source,
    flags: "g",
    replacement: "[REDACTED:jwt]",
    blocked: true,
    streaming: { mode: "jwt", prefix: "eyJ", leadingBoundary: true }
  },
  fixedTokenDefinition("google_api_key", [{
    prefixes: ["AIza"],
    bodySource: "[0-9A-Za-z_-]",
    minimumBodyLength: 20
  }], "[REDACTED:google_api_key]"),
  {
    kind: "token_assignment",
    source: /\b([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?)(?!\[REDACTED:)([^\s"',;]{8,})/gi.source,
    flags: "gi",
    replacement: (_match, prefix) => `${prefix}[REDACTED:secret]`,
    blocked: false
  }
];

const SECRET_PATTERN_SOURCES = SECRET_PATTERN_DEFINITIONS.map((definition) => definition.source);
const BLOCKED_REDACTION_KINDS = SECRET_PATTERN_DEFINITIONS
  .filter((definition) => definition.blocked)
  .map((definition) => definition.kind);
const BLOCKED_REDACTION_MARKERS = BLOCKED_REDACTION_KINDS.map(
  (kind) => `[REDACTED:${kind}]`
);
const BLOCKING_SECRET_PATTERNS = SECRET_PATTERN_DEFINITIONS
  .filter((definition) => definition.blocked)
  .map((definition) => new RegExp(definition.source, definition.flags.replace(/[gy]/g, "")));
const BOUNDED_STREAMING_MATCHERS = SECRET_PATTERN_DEFINITIONS.flatMap((definition) =>
  definition.blocked && definition.streaming?.mode === "bounded"
    ? definition.streaming.matchers
    : []
);
const FIXED_STREAMING_STARTS = BOUNDED_STREAMING_MATCHERS.map((matcher) => ({
  ...matcher,
  pattern: new RegExp(matcher.source, "g")
}));

function specializedStreamingMode(mode) {
  const streaming = SECRET_PATTERN_DEFINITIONS.find(
    (definition) => definition.blocked && definition.streaming?.mode === mode
  )?.streaming;
  if (!streaming || streaming.mode !== mode) {
    throw new Error(`Missing canonical ${mode} streaming definition.`);
  }
  return streaming;
}

const PEM_STREAMING = specializedStreamingMode("pem");
const JWT_STREAMING = specializedStreamingMode("jwt");
const AWS_SECRET_STREAMING = specializedStreamingMode("aws_secret");
const STREAM_SECRET_OVERLAP_LIMIT = Math.max(
  ...BLOCKED_REDACTION_MARKERS.map((marker) => marker.length),
  ...BOUNDED_STREAMING_MATCHERS.map((matcher) => matcher.maximumLength + 1),
  PEM_STREAMING.prefix.length + 1,
  JWT_STREAMING.prefix.length + 1,
  AWS_SECRET_STREAMING.prefix.length + 1
);

function redactSecrets(input) {
  let text = input;
  const redactions = [];
  for (const definition of SECRET_PATTERN_DEFINITIONS) {
    let count = 0;
    text = text.replace(new RegExp(definition.source, definition.flags), (...args) => {
      count += 1;
      const captures = args.slice(1, -2).map((value) => String(value));
      return typeof definition.replacement === "string"
        ? definition.replacement
        : definition.replacement(String(args[0]), ...captures);
    });
    if (count > 0) {
      redactions.push({ kind: definition.kind, count, blocked: definition.blocked });
    }
  }
  return {
    text,
    redactions,
    blocked: redactions.some((redaction) => redaction.blocked)
  };
}

function redact(value) {
  return value === undefined ? undefined : redactSecrets(value).text;
}

function containsBlockedRedaction(text) {
  return BLOCKED_REDACTION_MARKERS.some((marker) => text.includes(marker));
}

function containsBlockingSecretMaterial(text) {
  return containsBlockedRedaction(text) ||
    BLOCKING_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function inspectAndRedactSecrets(input) {
  const redacted = redactSecrets(input);
  const blocked = redacted.blocked || containsBlockedRedaction(input);
  return blocked === redacted.blocked ? redacted : { ...redacted, blocked };
}

const PEM_LABEL_END = "PRIVATE KEY-----";
const PEM_LABEL_SUFFIX_LENGTH = "PRIVATE KEY".length;
const NON_BASE64URL_CHARACTER = /[^A-Za-z0-9_-]/g;
const NON_PEM_LABEL_CHARACTER = /[^A-Z ]/g;
const NON_WHITESPACE_CHARACTER = /\S/g;
const NON_AWS_SECRET_CHARACTER = /[^A-Za-z0-9/+=]/g;

class StreamingBlockingSecretDetector {
  constructor() {
    this.overlap = "";
    this.blocked = false;
    this.fixedCandidates = [];
    this.jwtSegment = 0;
    this.jwtSegmentLength = 0;
    this.jwtLastCode = 0;
    this.pemInLabel = false;
    this.pemLabelTail = "";
    this.awsPhase = "search";
    this.awsBodyLength = 0;
  }

  write(text) {
    if (this.blocked || text.length === 0) {
      return this.blocked;
    }

    const overlapLength = this.overlap.length;
    const window = this.overlap + text;
    if (
      containsBlockedMarker(window) ||
      this.processFixedCandidates(text) ||
      this.startFixedCandidates(window, overlapLength) ||
      this.processJwt(text, window, overlapLength) ||
      this.processPem(text, window, overlapLength) ||
      this.processAwsSecret(text, window, overlapLength)
    ) {
      this.blocked = true;
      return true;
    }

    this.overlap = window.slice(-STREAM_SECRET_OVERLAP_LIMIT);
    return false;
  }

  blockedSecretSeen() {
    return this.finish();
  }

  finish() {
    if (!this.blocked && this.fixedCandidates.some((candidate) => isWordCharacter(candidate.lastCode))) {
      this.blocked = true;
    }
    if (
      !this.blocked &&
      this.jwtSegment === 3 &&
      this.jwtSegmentLength > 0 &&
      isWordCharacter(this.jwtLastCode)
    ) {
      this.blocked = true;
    }
    this.fixedCandidates = [];
    this.jwtSegment = 0;
    this.jwtSegmentLength = 0;
    this.jwtLastCode = 0;
    return this.blocked;
  }

  processFixedCandidates(text) {
    if (this.fixedCandidates.length === 0) {
      return false;
    }
    const retained = [];
    for (const candidate of this.fixedCandidates) {
      const result = advanceFixedCandidate(candidate, text);
      if (result.blocked) {
        return true;
      }
      if (result.active) {
        retained.push(candidate);
      }
    }
    this.fixedCandidates = retained;
    return false;
  }

  startFixedCandidates(window, overlapLength) {
    for (const matcher of FIXED_STREAMING_STARTS) {
      matcher.pattern.lastIndex = 0;
      let match;
      while ((match = matcher.pattern.exec(window)) !== null) {
        const matchEnd = match.index + match[0].length;
        if (matchEnd > overlapLength) {
          if (!matcher.trailingBoundary) {
            matcher.pattern.lastIndex = 0;
            return true;
          }
          const candidate = {
            matcher,
            lastCode: window.charCodeAt(matchEnd - 1)
          };
          const result = advanceFixedCandidate(candidate, window.slice(matchEnd));
          if (result.blocked) {
            matcher.pattern.lastIndex = 0;
            return true;
          }
          if (result.active) {
            this.fixedCandidates.push(candidate);
          }
        }
        if (match[0].length === 0) {
          matcher.pattern.lastIndex += 1;
        }
      }
      matcher.pattern.lastIndex = 0;
    }
    return false;
  }

  processJwt(text, window, overlapLength) {
    let input = this.jwtSegment === 0 ? window : text;
    let position = 0;
    let minimumEnd = this.jwtSegment === 0 ? overlapLength : -1;

    while (position < input.length) {
      if (this.jwtSegment === 0) {
        const prefixIndex = findLiteral(
          input,
          JWT_STREAMING.prefix,
          position,
          minimumEnd,
          JWT_STREAMING.leadingBoundary
        );
        if (prefixIndex < 0) {
          return false;
        }
        this.jwtSegment = 1;
        this.jwtSegmentLength = 0;
        position = prefixIndex + JWT_STREAMING.prefix.length;
        minimumEnd = -1;
      }

      if (this.jwtSegment === 3) {
        let reset = false;
        while (position < input.length) {
          const code = input.charCodeAt(position);
          if (this.jwtSegmentLength > 0 && isWordCharacter(this.jwtLastCode) !== isWordCharacter(code)) {
            return true;
          }
          if (!isBase64UrlCharacter(code)) {
            this.jwtSegment = 0;
            this.jwtSegmentLength = 0;
            this.jwtLastCode = 0;
            position += 1;
            minimumEnd = -1;
            reset = true;
            break;
          }
          this.jwtSegmentLength += 1;
          this.jwtLastCode = code;
          position += 1;
        }
        if (!reset) {
          return false;
        }
        continue;
      }

      const invalidIndex = findRegexIndex(NON_BASE64URL_CHARACTER, input, position);
      const runEnd = invalidIndex < 0 ? input.length : invalidIndex;
      const runLength = runEnd - position;
      this.jwtSegmentLength += runLength;
      if (invalidIndex < 0) {
        return false;
      }

      if (input[invalidIndex] === "." && this.jwtSegment < 3 && this.jwtSegmentLength > 0) {
        this.jwtSegment += 1;
        this.jwtSegmentLength = 0;
        this.jwtLastCode = 0;
        position = invalidIndex + 1;
        continue;
      }

      this.jwtSegment = 0;
      this.jwtSegmentLength = 0;
      this.jwtLastCode = 0;
      position = invalidIndex + 1;
      minimumEnd = -1;
    }
    return false;
  }

  processPem(text, window, overlapLength) {
    let input = this.pemInLabel ? text : window;
    let position = 0;
    let minimumEnd = this.pemInLabel ? -1 : overlapLength;

    while (position < input.length) {
      if (!this.pemInLabel) {
        const prefixIndex = findLiteral(
          input,
          PEM_STREAMING.prefix,
          position,
          minimumEnd,
          false
        );
        if (prefixIndex < 0) {
          return false;
        }
        this.pemInLabel = true;
        this.pemLabelTail = "";
        position = prefixIndex + PEM_STREAMING.prefix.length;
        minimumEnd = -1;
      }

      const retainedTailLength = this.pemLabelTail.length;
      const candidate = this.pemLabelTail + input.slice(position);
      const targetIndex = candidate.indexOf(PEM_LABEL_END);
      const invalidIndex = findRegexIndex(NON_PEM_LABEL_CHARACTER, candidate, 0);
      if (targetIndex >= 0 && invalidIndex === targetIndex + PEM_LABEL_SUFFIX_LENGTH) {
        return true;
      }

      if (invalidIndex < 0) {
        this.pemLabelTail = candidate.slice(-(PEM_LABEL_END.length - 1));
        return false;
      }

      const partialEnd = longestSuffixThatPrefixes(candidate, PEM_LABEL_END);
      if (partialEnd.length > 0 && candidate.length - partialEnd.length <= invalidIndex) {
        this.pemLabelTail = partialEnd;
        return false;
      }

      this.pemInLabel = false;
      this.pemLabelTail = "";
      position += Math.max(0, invalidIndex - retainedTailLength);
      minimumEnd = -1;
    }
    return false;
  }

  processAwsSecret(text, window, overlapLength) {
    let input = this.awsPhase === "search" ? window : text;
    let position = 0;
    let minimumEnd = this.awsPhase === "search" ? overlapLength : -1;

    while (position < input.length) {
      if (this.awsPhase === "search") {
        const prefixIndex = findLiteral(
          input,
          AWS_SECRET_STREAMING.prefix,
          position,
          minimumEnd,
          AWS_SECRET_STREAMING.leadingBoundary
        );
        if (prefixIndex < 0) {
          return false;
        }
        this.awsPhase = "separator";
        position = prefixIndex + AWS_SECRET_STREAMING.prefix.length;
        minimumEnd = -1;
      }

      if (this.awsPhase === "separator") {
        const significantIndex = findRegexIndex(NON_WHITESPACE_CHARACTER, input, position);
        if (significantIndex < 0) {
          return false;
        }
        if (input[significantIndex] === ":" || input[significantIndex] === "=") {
          this.awsPhase = "value";
          position = significantIndex + 1;
          continue;
        }
        this.awsPhase = "search";
        position = significantIndex;
        minimumEnd = -1;
        continue;
      }

      if (this.awsPhase === "value") {
        const valueIndex = findRegexIndex(NON_WHITESPACE_CHARACTER, input, position);
        if (valueIndex < 0) {
          return false;
        }
        if (input[valueIndex] === "\"" || input[valueIndex] === "'") {
          this.awsPhase = "body";
          this.awsBodyLength = 0;
          position = valueIndex + 1;
          continue;
        }
        if (isAwsSecretCharacter(input.charCodeAt(valueIndex))) {
          this.awsPhase = "body";
          this.awsBodyLength = 1;
          position = valueIndex + 1;
          continue;
        }
        this.awsPhase = "search";
        position = valueIndex;
        minimumEnd = -1;
        continue;
      }

      const invalidIndex = findRegexIndex(NON_AWS_SECRET_CHARACTER, input, position);
      const runEnd = invalidIndex < 0 ? input.length : invalidIndex;
      this.awsBodyLength += runEnd - position;
      if (this.awsBodyLength >= 40) {
        return true;
      }
      if (invalidIndex < 0) {
        return false;
      }
      this.awsPhase = "search";
      this.awsBodyLength = 0;
      position = invalidIndex;
      minimumEnd = -1;
    }
    return false;
  }
}

function advanceFixedCandidate(candidate, text) {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (isWordCharacter(candidate.lastCode) !== isWordCharacter(code)) {
      return { active: false, blocked: true };
    }
    if (candidate.matcher.exactBodyLength || !candidate.matcher.bodyPattern.test(character)) {
      return { active: false, blocked: false };
    }
    candidate.lastCode = code;
  }
  return { active: true, blocked: false };
}

function containsBlockedMarker(text) {
  return text.includes("[REDACTED:") &&
    BLOCKED_REDACTION_MARKERS.some((marker) => text.includes(marker));
}

function findLiteral(input, literal, start, minimumEnd, leadingBoundary) {
  let position = minimumEnd >= 0
    ? Math.max(start, minimumEnd - literal.length + 1)
    : start;
  while (position < input.length) {
    const index = input.indexOf(literal, position);
    if (index < 0) {
      return -1;
    }
    const touchesNewText = minimumEnd < 0 || index + literal.length > minimumEnd;
    const hasBoundary = !leadingBoundary ||
      index === 0 ||
      !isWordCharacter(input.charCodeAt(index - 1));
    if (touchesNewText && hasBoundary) {
      return index;
    }
    position = index + 1;
  }
  return -1;
}

function findRegexIndex(pattern, input, start) {
  pattern.lastIndex = start;
  const match = pattern.exec(input);
  pattern.lastIndex = 0;
  return match === null ? -1 : match.index;
}

function longestSuffixThatPrefixes(value, pattern) {
  const maxLength = Math.min(value.length, pattern.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (pattern.startsWith(suffix)) {
      return suffix;
    }
  }
  return "";
}

function isWordCharacter(code) {
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122);
}

function isBase64UrlCharacter(code) {
  return isWordCharacter(code) || code === 45;
}

function isAwsSecretCharacter(code) {
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 47 ||
    code === 61;
}

module.exports = {
  BLOCKED_REDACTION_KINDS,
  SECRET_PATTERN_SOURCES,
  StreamingBlockingSecretDetector,
  containsBlockedRedaction,
  containsBlockingSecretMaterial,
  inspectAndRedactSecrets,
  redact,
  redactSecrets
};

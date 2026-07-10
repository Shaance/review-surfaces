// review-surfaces.NARRATIVE.1-5: build the grounded change narrative that opens
// the human surface.
//
// The narrative is prose over deterministic facts produced through the provider
// boundary (mock / agent-file / ai-sdk). Every claim is validated against a
// deterministic anchor allowlist (changed files, ACIDs, command transcripts):
//   - all anchors valid (and the prose names nothing off-allowlist) -> internal
//     `verified` compatibility value, rendered to users as `anchored`
//   - any anchor missing/invalid -> `claimed` (DEMOTED and visibly marked with
//     the offending tokens, never dropped silently or rendered as fact).
// It never creates/clears blockers or alters the verdict — the builder only
// returns claims; the caller stores them read-only on the model.
//
// Mock, a non-ok provider result, or a narrative with nothing usable falls back
// to a deterministic summary so the section always renders without failing.

import { TEXT_ACID_TOKEN, TEXT_PATH_TOKEN, TEXT_ROOT_FILE_TOKEN } from "../core/anchor-tokens";
import { isRecord } from "../core/guards";
import { EvidenceRef } from "../evidence/evidence";
import { ProviderName, ReasoningProvider } from "../llm/provider";
import { PrReviewSurfaceModel, StructuredDiff } from "../pr/contract";
import { redactSecrets } from "../privacy/secrets";
import { ReviewPacket } from "../render/packet";
import { ChangeNarrative, NarrativeClaim, NarrativeClaimTrust } from "./contract";

export const DEFAULT_NARRATIVE_MAX_CLAIMS = 8;
const MAX_NARRATIVE_MAX_CLAIMS = 16;
const MAX_CLAIM_TEXT_CHARS = 280;

// Provider output contract: claims with optional structured anchors.
export const HUMAN_NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    claims: {
      type: "array",
      maxItems: MAX_NARRATIVE_MAX_CLAIMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          requirement_ids: { type: "array", items: { type: "string" } },
          command_ids: { type: "array", items: { type: "string" } }
        },
        required: ["text"]
      }
    }
  },
  required: ["claims"]
} as const;

export interface NarrativeAllowlist {
  paths: Set<string>;
  requirementIds: Set<string>;
  commandIds: Set<string>;
}

// The deterministic facts the narrative is anchored against (no provider).
export interface NarrativeFacts {
  packet: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  diff?: StructuredDiff;
  headSha: string;
  maxClaims?: number;
}

export interface BuildChangeNarrativeInput extends NarrativeFacts {
  provider: ReasoningProvider;
  providerName: ProviderName;
  redactSecrets: boolean;
  remotePrivacyBlocked: boolean;
}

export async function buildChangeNarrative(input: BuildChangeNarrativeInput): Promise<ChangeNarrative> {
  const allowlist = buildNarrativeAllowlist(input);
  const maxClaims = clampMaxClaims(input.maxClaims);
  // Reuse the already-built allowlist for any fallback path below.
  const fallback = (): ChangeNarrative => buildFallbackNarrative(input, input.providerName, allowlist);

  // Mock never enriches (review-surfaces.NARRATIVE.5): deterministic fallback.
  if (input.providerName === "mock") {
    return fallback();
  }

  const result = await input.provider.generateStructured(
    "human_narrative",
    narrativePrompt(input, allowlist),
    HUMAN_NARRATIVE_SCHEMA,
    { redactSecrets: input.redactSecrets, remotePrivacyBlocked: input.remotePrivacyBlocked }
  );
  if (!result.ok || !isRecord(result.data)) {
    return fallback();
  }
  const claims = validateClaims(result.data.claims, allowlist, maxClaims);
  if (claims.length === 0) {
    // Provider returned nothing usable: render the deterministic fallback rather
    // than an empty narrative section.
    return fallback();
  }
  return {
    source: "provider",
    provider: input.providerName,
    validated_at_head: input.headSha,
    claims
  };
}

// Build the deterministic anchor allowlist from the changed files, affected
// requirements, and recorded command transcripts available at build time.
export function buildNarrativeAllowlist(input: NarrativeFacts): NarrativeAllowlist {
  const paths = new Set<string>();
  for (const file of input.diff?.files ?? []) {
    paths.add(file.path);
    if (file.old_path) {
      paths.add(file.old_path);
    }
  }
  for (const file of input.prSurface?.scope.changed_files ?? []) {
    paths.add(file.path);
  }

  const requirementIds = new Set<string>();
  for (const result of input.packet.evaluation.results ?? []) {
    requirementIds.add(result.requirement_id);
    if (result.acai_id) {
      requirementIds.add(result.acai_id);
    }
  }
  for (const requirement of input.prSurface?.scope.affected_requirements ?? []) {
    requirementIds.add(requirement.requirement_id);
    if (requirement.acai_id) {
      requirementIds.add(requirement.acai_id);
    }
  }

  const commandIds = new Set<string>();
  // Only test-evidence rows actually backed by a transcript or a parsed-test
  // result (a valid command/test evidence ref) are verified command anchors. This
  // excludes feedback-only rows (feedback evidence, no captured output) and
  // failed/claimed/missing rows, so a claim citing such an id is not over-trusted.
  for (const entry of transcriptBackedTestEvidence(input.packet)) {
    if (entry.id) {
      commandIds.add(entry.id);
    }
    for (const id of commandIdTokens(entry.id)) {
      commandIds.add(id);
    }
    // The transcript id is stored in event_id (and sometimes the note), not just
    // the shell text. Allowlist the RAW event_id too — a custom transcript id like
    // `smoke_1` (from `run --id smoke_1`) does not match the CMD-/TEST- token
    // pattern, so a claim citing it would otherwise be wrongly demoted.
    for (const ref of entry.evidence ?? []) {
      if (ref.kind === "command" && ref.validation_status === "valid") {
        if (ref.event_id) {
          commandIds.add(ref.event_id);
        }
        for (const token of [ref.command, ref.note, ref.event_id]) {
          for (const id of commandIdTokens(token)) {
            commandIds.add(id);
          }
        }
      }
    }
  }
  // Command ids from general evaluation/risk evidence are only allowlisted when
  // the ref itself is a VALID (proven) command — methodology/risk evidence can
  // record failed transcript ids too, and those must not become verified anchors.
  for (const ref of resultAndRiskEvidence(input.packet)) {
    if (ref.kind === "command" && ref.validation_status === "valid") {
      for (const token of [ref.command, ref.note, ref.event_id]) {
        for (const id of commandIdTokens(token)) {
          commandIds.add(id);
        }
      }
    }
  }

  return { paths, requirementIds, commandIds };
}

function validateClaims(value: unknown, allowlist: NarrativeAllowlist, maxClaims: number): NarrativeClaim[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const claims: NarrativeClaim[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.text !== "string") {
      continue;
    }
    const text = boundedRedacted(raw.text);
    if (text.length === 0) {
      continue;
    }
    const { anchors, invalid } = classifyAnchors(raw, allowlist, text);
    // The internal `verified` value means citation-anchored only: at least one
    // valid anchor AND
    // cites nothing off-allowlist (structured or in prose); otherwise DEMOTE to
    // claimed and surface the offending tokens.
    const trust: NarrativeClaimTrust = invalid.length === 0 && anchors.length > 0 ? "verified" : "claimed";
    claims.push({
      id: `NARR-${String(claims.length + 1).padStart(3, "0")}`,
      text,
      trust,
      anchors,
      invalid_anchors: invalid
    });
    if (claims.length >= maxClaims) {
      break;
    }
  }
  return claims;
}

function classifyAnchors(
  raw: Record<string, unknown>,
  allowlist: NarrativeAllowlist,
  text: string
): { anchors: EvidenceRef[]; invalid: string[] } {
  const anchors: EvidenceRef[] = [];
  const invalid: string[] = [];
  // Redact invalid anchor tokens before storing them: they are written verbatim
  // into human_review.json/Markdown, so a secret-looking value in a malformed
  // provider/agent payload must be redacted like the claim prose.
  const note = (value: string): void => {
    const redacted = redactSecrets(value).text;
    if (!invalid.includes(redacted)) {
      invalid.push(redacted);
    }
  };

  // Walk a structured anchor field. An agent-file payload is NOT schema-validated,
  // so a malformed field (not an array) or a malformed element (not a string)
  // must demote the claim rather than be silently dropped by asStringArray, which
  // would let the remaining valid anchors over-trust it.
  const eachAnchor = (value: unknown, onValid: (token: string) => void): void => {
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value)) {
      note("[malformed anchor field]");
      return;
    }
    for (const element of value) {
      if (typeof element !== "string") {
        note("[malformed anchor]");
      } else {
        onValid(element);
      }
    }
  };

  eachAnchor(raw.paths, (path) =>
    allowlist.paths.has(path) ? anchors.push(validAnchor({ kind: "file", path })) : note(path)
  );
  eachAnchor(raw.requirement_ids, (id) =>
    allowlist.requirementIds.has(id) ? anchors.push(validAnchor({ kind: "spec", acai_id: id })) : note(id)
  );
  eachAnchor(raw.command_ids, (command) =>
    allowlist.commandIds.has(command) ? anchors.push(validAnchor({ kind: "command", command })) : note(command)
  );
  // The prose itself must not smuggle a fabricated path/ACID. A token the prose
  // names that is not on an allowlist demotes the claim (it is still shown, but
  // marked claimed with the token surfaced).
  for (const token of proseAnchorTokens(text)) {
    if (!allowlist.paths.has(token) && !allowlist.requirementIds.has(token) && !allowlist.commandIds.has(token)) {
      note(token);
    }
  }
  return { anchors, invalid };
}

// Deterministic fallback narrative (review-surfaces.NARRATIVE.5): a bounded set
// of verified claims derived from packet facts, each anchored to real evidence.
// Synchronous and provider-free, so every build path (all / cache / standalone)
// can always render a narrative without an LLM call.
export function buildFallbackNarrative(
  input: NarrativeFacts,
  provider: ProviderName = "mock",
  reusableAllowlist?: NarrativeAllowlist
): ChangeNarrative {
  const allowlist = reusableAllowlist ?? buildNarrativeAllowlist(input);
  const maxClaims = clampMaxClaims(input.maxClaims);
  const claims: NarrativeClaim[] = [];
  const add = (text: string, anchors: EvidenceRef[]): void => {
    if (claims.length >= maxClaims || anchors.length === 0) {
      return;
    }
    claims.push({
      id: `NARR-${String(claims.length + 1).padStart(3, "0")}`,
      text: boundedRedacted(text),
      trust: "verified",
      anchors,
      invalid_anchors: []
    });
  };

  const changedPaths = [...allowlist.paths];
  if (changedPaths.length > 0) {
    add(
      `The change touches ${changedPaths.length} file(s).`,
      changedPaths.slice(0, 4).map((path) => validAnchor({ kind: "file", path }))
    );
  }

  const missing = (input.packet.evaluation.results ?? []).filter((result) => result.status === "missing" || result.status === "partial");
  const missingAcids = compact(missing.map((result) => result.acai_id ?? result.requirement_id));
  if (missingAcids.length > 0) {
    add(
      `${missing.length} requirement(s) still need implementation or test evidence.`,
      missingAcids.slice(0, 4).map((id) => validAnchor({ kind: "spec", acai_id: id }))
    );
  }

  const riskItems = input.packet.risks.items ?? [];
  // Anchor the risk claim to the risks' REAL evidence (changed files / ACIDs on
  // the allowlist) — NARRATIVE.2 allowed anchor types — rather than the risk row
  // id (RISK-001), which is not an allowlisted anchor type.
  const riskAnchors = dedupeAnchors(
    riskItems.flatMap((risk) => risk.evidence ?? []).flatMap((ref) => allowlistedRiskAnchor(ref, allowlist))
  ).slice(0, 4);
  if (riskItems.length > 0) {
    add(`${riskItems.length} packet risk(s) were identified for review.`, riskAnchors);
  }

  // Count distinct transcript-backed ROWS (not the allowlist, which may hold both
  // a row id and a CMD-* token from the same row, double-counting it).
  const transcriptCount = transcriptBackedTestEvidence(input.packet).length;
  const commandIds = [...allowlist.commandIds];
  if (transcriptCount > 0 && commandIds.length > 0) {
    add(
      `${transcriptCount} command transcript(s) back the recorded validation evidence.`,
      commandIds.slice(0, 4).map((command) => validAnchor({ kind: "command", command }))
    );
  }

  return {
    source: "fallback",
    provider,
    validated_at_head: input.headSha,
    claims
  };
}

function narrativePrompt(input: BuildChangeNarrativeInput, allowlist: NarrativeAllowlist): string {
  return [
    "Write 5-8 short plain-language claims describing what this change does, why it matters, and where risk concentrates.",
    "Each claim MUST cite at least one anchor from the allowed lists below; do NOT invent paths, requirement IDs, or commands.",
    "Return compact JSON only: { claims: [ { text, paths?, requirement_ids?, command_ids? } ] }.",
    `allowed_paths: ${[...allowlist.paths].slice(0, 60).join(", ") || "(none)"}`,
    `allowed_requirement_ids: ${[...allowlist.requirementIds].slice(0, 60).join(", ") || "(none)"}`,
    `allowed_command_ids: ${[...allowlist.commandIds].slice(0, 30).join(", ") || "(none)"}`,
    `intent: ${String(input.packet.intent.summary)}`,
    `evaluation: ${String(input.packet.evaluation.summary)}`,
    `risks: ${String(input.packet.risks.summary)}`
  ].join("\n");
}

// --- helpers ---------------------------------------------------------------

function clampMaxClaims(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_NARRATIVE_MAX_CLAIMS;
  }
  return Math.min(value, MAX_NARRATIVE_MAX_CLAIMS);
}

function boundedRedacted(text: string): string {
  const cleaned = redactSecrets(text).text.replace(/\s+/g, " ").trim();
  return cleaned.length <= MAX_CLAIM_TEXT_CHARS ? cleaned : `${cleaned.slice(0, MAX_CLAIM_TEXT_CHARS - 1)}…`;
}

// A deterministically-validated anchor: high confidence, validation_status valid.
function validAnchor(ref: Omit<EvidenceRef, "confidence" | "validation_status">): EvidenceRef {
  return { ...ref, confidence: "high", validation_status: "valid" };
}

// Map a packet-risk evidence ref to an allowlisted narrative anchor (a changed
// file or an ACID). Returns [] for evidence that is not an allowed anchor type or
// not on the allowlist, so a risk claim is only anchored to real, allowed proof.
function allowlistedRiskAnchor(ref: EvidenceRef, allowlist: NarrativeAllowlist): EvidenceRef[] {
  if (ref.path && allowlist.paths.has(ref.path)) {
    return [validAnchor({ kind: "file", path: ref.path })];
  }
  if (ref.acai_id && allowlist.requirementIds.has(ref.acai_id)) {
    return [validAnchor({ kind: "spec", acai_id: ref.acai_id })];
  }
  return [];
}

function dedupeAnchors(anchors: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const anchor of anchors) {
    const key = `${anchor.kind}:${anchor.path ?? ""}:${anchor.acai_id ?? ""}:${anchor.command ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(anchor);
    }
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compact(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

// Path/ACID/root-file/command tokens in prose, using the shared anchored-or-
// flagged scanners so the human narrative stays in lockstep with the PR
// narrative. The command-id scan is included so a fabricated `CMD-...` mentioned
// in prose is demoted the same way as a fabricated path or ACID.
function proseAnchorTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const pattern of [TEXT_PATH_TOKEN, TEXT_ROOT_FILE_TOKEN, TEXT_ACID_TOKEN, COMMAND_ID_TOKEN]) {
    for (const match of text.matchAll(pattern)) {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

// A command-transcript / test-evidence row id embedded in text, e.g.
// CMD-PNPM-BUILD, CMD-001, TEST-TR-001, TEST-001. Scanned in prose so a
// fabricated id is demoted, and used to pull ids out of command evidence. The
// first character after the dash may be a digit (the built-in numeric CMD-001
// form), so a fabricated numeric id is surfaced too.
const COMMAND_ID_TOKEN = /\b(?:CMD|TEST)-[A-Z0-9][A-Z0-9-]*\b/g;

function commandIdTokens(value: string | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return [...value.matchAll(COMMAND_ID_TOKEN)].map((match) => match[0]);
}

// test-evidence rows that actually back validation: a passing/usable row
// (direct/indirect) AND a valid command/test evidence ref. A FAILED transcript
// still carries a "valid" command ref (the transcript itself is valid evidence)
// but its row kind is `missing`, so the kind check is required too; this also
// excludes feedback-only rows (no valid command/test ref) and claimed/unknown
// rows, so only real, passing validation backs a verified command anchor.
const USABLE_TEST_EVIDENCE_KINDS = new Set(["direct", "indirect"]);

function transcriptBackedTestEvidence(packet: ReviewPacket): ReviewPacket["risks"]["test_evidence"] {
  return (packet.risks.test_evidence ?? []).filter(
    (entry) =>
      USABLE_TEST_EVIDENCE_KINDS.has(entry.kind) &&
      (entry.evidence ?? []).some(
        (ref) => (ref.kind === "command" || ref.kind === "test") && ref.validation_status === "valid"
      )
  );
}

function resultAndRiskEvidence(packet: ReviewPacket): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const result of packet.evaluation.results ?? []) {
    refs.push(...(result.evidence ?? []));
  }
  for (const risk of packet.risks.items ?? []) {
    refs.push(...(risk.evidence ?? []));
  }
  return refs;
}

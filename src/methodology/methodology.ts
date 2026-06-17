import { CollectionResult } from "../collector/collect";
import { ConversationEvent, ConversationFormat } from "../conversation/events";
import { loadConversationEvents, writeNormalizedConversation } from "../conversation/ingest";
import { commandEvidence, EvidenceRef, missingEvidence } from "../evidence/evidence";
import { computeCrossReferenceSignals } from "./cross-reference";
import { PacketSeverity, PacketWorkflowSignalKind } from "../schema/review-packet-contract";

// review-surfaces.METHODOLOGY.7/.8: a validated item-4 workflow finding produced
// by the methodology leaf (unchallenged assumption, skipped step, workflow
// soundness, or one of the LLM cross-reference signals). Advisory by default
// (D5) — it never moves the deterministic verdict on its own.
export interface WorkflowFinding {
  id: string;
  signal_kind: PacketWorkflowSignalKind;
  summary: string;
  severity: PacketSeverity;
  advisory: boolean;
  evidence: EvidenceRef[];
}

export interface MethodologyModel {
  summary: string;
  missing_logs: boolean;
  considered: string[];
  research: string[];
  decisions: string[];
  unchallenged_assumptions: string[];
  skipped_checks: string[];
  claims_without_evidence: string[];
  verified_claims: string[];
  quality_flags: string[];
  evidence: EvidenceRef[];
  // House tighter-than-schema pattern: REQUIRED []-defaulted array (optional in
  // the JSON schema). EVERY code path — including the degraded keyword fallback —
  // populates it (at least []). The leaf fills it; the fallback leaves it empty.
  workflow_findings: WorkflowFinding[];
  // The harness adapter label (claude-code|codex|cursor|normalized) when a
  // conversation was ingested; omitted otherwise / on the degraded path.
  conversation_source?: string;
}

interface TranscriptCommandEvidence {
  passed: Set<string>;
  failed: Set<string>;
}

export async function buildMethodology(
  cwd: string,
  collection: CollectionResult,
  conversationPath: string | undefined,
  commands: string[],
  conversationFormat?: ConversationFormat
): Promise<MethodologyModel> {
  // Phase 1.5: the SINGLE producer runs inside collect.ts and attaches the
  // redacted stream to CollectionResult, so both buildMethodology call sites READ
  // collection.conversationEvents rather than re-parsing. The direct-load
  // fallback below only serves unit-test callers (and any path that did not run
  // the collector seam); production never re-parses here.
  let events = collection.conversationEvents;
  let source = collection.conversationSource;
  if (!events && conversationPath) {
    const loaded = await loadConversationEvents(cwd, conversationPath, conversationFormat);
    if (loaded) {
      events = loaded.events;
      source = loaded.adapter;
      await writeNormalizedConversation(collection.outputDir, loaded.events);
    }
  }

  // review-surfaces.METHODOLOGY.4: a missing --conversation, an unreadable file,
  // an unmatched shape, OR an adapter that matched but produced ZERO events (e.g.
  // an empty `{ "messages": [] }` export) all degrade to a non-fatal finding —
  // never "extracted 0 events" reported as a real audit. When a path WAS supplied
  // but failed, say so (so the adapter/format problem is visible) rather than
  // reusing the not-provided message (Codex P2).
  if (!events || events.length === 0) {
    const supplied = conversationPath !== undefined;
    const reason = supplied
      ? `Conversation log at ${conversationPath} could not be parsed into events (unreadable, an unrecognized format, or empty).`
      : "Conversation log not_provided; methodology is derived only from local files and command context.";
    return {
      summary: reason,
      missing_logs: true,
      considered: [],
      research: [],
      decisions: ["Use local deterministic evidence first; optional enrichment cannot prove behavior."],
      unchallenged_assumptions: ["No conversation log was supplied, so options considered outside files are unknown."],
      skipped_checks: [
        supplied
          ? `Conversation methodology audit skipped: ${conversationPath} produced no events (check --conversation-format).`
          : "Conversation methodology audit skipped: --conversation not provided."
      ],
      claims_without_evidence: [],
      verified_claims: [],
      // Also flag the deep audit as not-run so renderers that key off
      // methodology_analysis_degraded show the SAME "audit not run" signal a
      // mock/no-provider run shows for a parsed log (Codex P2).
      quality_flags: ["conversation_log_missing", "methodology_analysis_degraded"],
      evidence: [missingEvidence(supplied ? `Conversation log ${conversationPath} produced no usable events.` : "No conversation log was provided.")],
      // METHODOLOGY.8 (D6): the deterministic cross-reference signals are diff-based,
      // so they still fire when no conversation is available (the empty transcript IS
      // maximal "no discussion") — the deterministic shell works without the leaf.
      workflow_findings: computeCrossReferenceSignals(collection, [])
    };
  }

  const transcriptCommandEvidence = buildTranscriptCommandEvidence(collection);
  const validationClaims = pickValidationClaims(events);
  const verifiedClaims = validationClaims.filter((claim) => claimHasCommandEvidence(claim, transcriptCommandEvidence));
  const claimsWithoutEvidence = validationClaims.filter((claim) => !claimHasCommandEvidence(claim, transcriptCommandEvidence));
  const qualityFlags = [
    ...(claimsWithoutEvidence.length > 0 ? ["test_claims_without_command_evidence"] : []),
    ...(verifiedClaims.length > 0 ? ["test_claims_verified_by_command_transcripts"] : []),
    // review-surfaces.METHODOLOGY.7 (D2): the deterministic builder is the
    // FALLBACK. Mark the deep audit as not-run by default; a successful provider
    // leaf (runMethodologyReasoning) clears this flag and fills workflow_findings.
    // Under the mock default (the de-facto shipped OUTPUT) the leaf never runs, so
    // this flag stays — the cockpit must never mistake the fallback for the audit.
    "methodology_analysis_degraded"
  ];

  const sourceLabel = conversationPath ?? source ?? "the discovered conversation";
  return {
    summary: `Methodology extracted ${events.length} event(s) from ${sourceLabel}.`,
    missing_logs: false,
    considered: pick(events, ["option", "considered", "alternative"]),
    research: pick(events, ["research", "inspect", "read", "context", "reference"]),
    decisions: pick(events, ["decide", "decision", "chose", "choose"]),
    unchallenged_assumptions: pick(events, ["assume", "assumption"]),
    skipped_checks: [
      ...pick(events, ["skip", "skipped", "not run", "could not"]),
      ...commands.filter((command) => command.includes("ai-sdk skipped"))
    ],
    claims_without_evidence: claimsWithoutEvidence,
    verified_claims: verifiedClaims,
    quality_flags: qualityFlags,
    evidence: [
      {
        kind: "conversation",
        // Phase 5b (PRIVACY.1): an auto-discovered session carries a repo-relative
        // normalized-log anchor (collection.conversationEvidencePath), NEVER its
        // absolute home-dir path — which would fail isSafeRepositoryPath and leak a
        // username-bearing path into a persisted artifact. An explicit --conversation
        // path keeps its own value.
        path: collection.conversationEvidencePath ?? conversationPath,
        // Carry a real normalized event id so this conversation-kind ref stays
        // VALID under the new validateEvidenceRef rule (a conversation ref now
        // requires a known event_id; path membership alone is insufficient).
        event_id: events[0].id,
        confidence: "medium",
        validation_status: "valid",
        note: "Conversation was normalized into inputs/conversation.normalized.jsonl."
      },
      ...(collection.commandTranscripts ?? []).map((transcript) =>
        commandEvidence(
          transcript.command,
          `Command transcript ${transcript.id} supports methodology claim checking.`,
          transcript.exit_code === 0 ? "high" : "medium",
          {
            path: collection.commandTranscriptOutputPath,
            eventId: transcript.id,
            excerptHash: transcript.stdout_hash ?? transcript.stderr_hash,
            validationStatus: "valid"
          }
        )
      ),
      ...commands.map((command) => commandEvidence(command, "Command associated with this review run.", "medium"))
    ],
    // review-surfaces.METHODOLOGY.8 (D6): the deterministic cross-reference signals
    // fire here (offline), so they are present even under the mock provider; a
    // running LLM leaf APPENDS its proposed findings on top (runMethodologyAuditStage).
    workflow_findings: computeCrossReferenceSignals(collection, events),
    ...(source !== undefined ? { conversation_source: source } : {})
  };
}

// review-surfaces.METHODOLOGY.1: the deterministic keyword fallback for
// considered/research/decisions/etc. Scans ONLY natural-language turns — a
// tool_call/tool_result summary is an embedded body (file content, an edit payload,
// a command's stdout) where a keyword match is noise, not a considered alternative,
// and pushing it whole dumped kilobytes of code onto the cockpit card (found by
// dogfooding the live session). Each kept entry is bounded so even a long message
// stays scannable.
const PICK_TEXT_LIMIT = 200;
// Only the TOOL kinds are excluded (their summary is an embedded body); every other
// kind is natural language. `ConversationEvent.kind` is intentionally loose, so a
// normalized log's custom kind (e.g. {kind:"analysis"}) must still be picked — a
// whitelist would silently drop it (Codex P2). Mirrors the Phase-3a discussion check.
const PICK_TOOL_KINDS = new Set(["tool_call", "tool_result"]);

function pick(events: ConversationEvent[], keywords: string[]): string[] {
  const result: string[] = [];
  for (const event of events) {
    if (result.length >= 12) {
      break;
    }
    if (PICK_TOOL_KINDS.has(event.kind)) {
      continue;
    }
    const lower = event.summary.toLowerCase();
    if (keywords.some((keyword) => lower.includes(keyword))) {
      const text = event.summary.length > PICK_TEXT_LIMIT ? `${event.summary.slice(0, PICK_TEXT_LIMIT).trimEnd()}…` : event.summary;
      result.push(`${event.id}: ${text}`);
    }
  }
  return result;
}

function pickValidationClaims(events: ConversationEvent[]): string[] {
  const result: string[] = [];
  for (const event of events) {
    if (isValidationSuccessClaim(event.summary) || isValidationFailureClaim(event.summary)) {
      result.push(`${event.id}: ${event.summary}`);
    }
  }
  return result;
}

function isValidationSuccessClaim(summary: string): boolean {
  const lower = summary.toLowerCase();
  const mentionsValidation = /\b(?:tests?|tested|test suite|lint|typecheck|type check|build|validation|checks?|pnpm|npm|yarn|bun|node --test|tsc)\b/.test(lower);
  const claimsSuccess = /\b(?:tested|pass|passed|passes|passing|green|succeeded|successful|success|validated|verified)\b/.test(lower);
  if (!mentionsValidation || !claimsSuccess) {
    return false;
  }
  return !/\b(?:missing|needs?|add|todo|skipped|skip|not run|could not|cannot|can't|gap|uncovered)\b|\b(?:should|could|would|might|may|will|expect(?:ed)? to)\s+(?:pass|passed|passes|green|succeed|succeeded|successful|validate|validated|verify|verified)\b|\bnot\s+(?:pass|passed|passing|green|successful|validated|verified)\b/.test(lower);
}

function isValidationFailureClaim(summary: string): boolean {
  const lower = summary.toLowerCase();
  const mentionsValidation = /\b(?:tests?|test suite|lint|typecheck|type check|build|validation|checks?|pnpm|npm|yarn|bun|node --test|tsc)\b/.test(lower);
  const claimsFailure = /\b(?:fail|failed|failing|errored|error)\b/.test(lower);
  if (!mentionsValidation || !claimsFailure) {
    return false;
  }
  return !/\b(?:needs?|add|todo|skipped|skip|not run|could not|cannot|can't|gap|uncovered)\b|\b(?:should|could|would|might|may|will|expect(?:ed)? to)\s+(?:fail|failed|failing|error|errored)\b/.test(lower);
}

function buildTranscriptCommandEvidence(collection: CollectionResult): TranscriptCommandEvidence {
  const evidence: TranscriptCommandEvidence = {
    passed: new Set(),
    failed: new Set()
  };
  for (const transcript of collection.commandTranscripts ?? []) {
    const command = normalizeCommand(transcript.command);
    if (transcript.status === "passed" && transcript.exit_code === 0) {
      evidence.passed.add(command);
    } else if (transcript.status === "failed" || (typeof transcript.exit_code === "number" && transcript.exit_code !== 0)) {
      evidence.failed.add(command);
    }
  }
  return evidence;
}

function claimHasCommandEvidence(claim: string, transcriptCommands: TranscriptCommandEvidence): boolean {
  const claimedCommands = extractClaimedCommands(claim);
  if (claimedCommands.length === 0) {
    return false;
  }
  if (isValidationSuccessClaim(claim)) {
    return claimedCommands.every((command) => transcriptCommands.passed.has(command));
  }
  if (isValidationFailureClaim(claim)) {
    return claimedCommands.every((command) => transcriptCommands.failed.has(command));
  }
  return false;
}

function normalizeCommand(command: string): string {
  return command.toLowerCase().trim().replace(/\s+/g, " ");
}

function extractClaimedCommands(claim: string): string[] {
  const commands: string[] = [];
  const normalizedClaim = normalizeCommand(claim);
  const commandStarts = [...normalizedClaim.matchAll(/\b(?:pnpm|npm|yarn|bun|node|tsc)\b/g)];
  for (let index = 0; index < commandStarts.length; index += 1) {
    const start = commandStarts[index].index ?? 0;
    const end = commandStarts[index + 1]?.index ?? normalizedClaim.length;
    const command = cleanClaimedCommand(normalizedClaim.slice(start, end));
    if (command && commandLooksSupported(command)) {
      commands.push(command);
    }
  }
  return [...new Set(commands)];
}

function cleanClaimedCommand(value: string): string {
  return normalizeCommand(value)
    .replace(/\s+\b(?:passed|passes|passing|green|succeeded|successful|success|validated|verified|tested|fail|failed|failing|errored|error|after|before|because|so|while|when)\b.*$/i, "")
    .replace(/\s+\b(?:and|then)\s*$/i, "")
    .replace(/\s*(?:,|;|&&|\|\|)\s*$/i, "")
    .replace(/[`'")\]]+$/g, "")
    .trim();
}

function commandLooksSupported(command: string): boolean {
  return /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+[\w:.-]+|exec\s+[\w:.-]+|test(?::[\w.-]+)?|lint|typecheck|build)(?:\s+[^\s,;]+)*|node\s+--test(?:\s+[^\s,;]+)*|tsc(?:\s+[^\s,;]+)*)$/.test(command);
}

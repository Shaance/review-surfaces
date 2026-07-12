import { CollectionResult } from "../collector/collect";
import { ConversationEvent, ConversationFormat, isConversationToolCall, isConversationToolOutput } from "../conversation/events";
import { loadConversationEvents, writeNormalizedConversation } from "../conversation/ingest";
import { commandEvidence, EvidenceRef, missingEvidence } from "../evidence/evidence";
import { computeCrossReferenceSignals } from "./cross-reference";
import { PacketSeverity, PacketWorkflowSignalKind } from "../schema/review-packet-contract";
import { conversationEventLooksLikeGeneratedPayload, conversationReviewerText } from "../conversation/generated-payload";

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
  conversation_discovery?: NonNullable<CollectionResult["conversationDiscovery"]>;
}

interface TranscriptCommandEvidence {
  passed: Map<string, string[]>;
  failed: Map<string, string[]>;
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
      workflow_findings: computeCrossReferenceSignals(collection, []),
      ...(collection.conversationDiscovery ? { conversation_discovery: collection.conversationDiscovery } : {})
    };
  }

  const transcriptCommandEvidence = buildTranscriptCommandEvidence(collection);
  const validationClaims = pickValidationClaims(events);
  const pickableEvents = preparePickableEvents(events);
  const verifiedClaims: string[] = [];
  const claimsWithoutEvidence: string[] = [];
  for (const claim of validationClaims) {
    const transcriptIds = claimCommandEvidenceIds(claim.evidenceText, transcriptCommandEvidence);
    if (transcriptIds) {
      verifiedClaims.push(withCommandEvidenceReference(claim.persistedText, transcriptIds));
    } else {
      claimsWithoutEvidence.push(claim.persistedText);
    }
  }
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
    considered: pick(pickableEvents, ["option", "considered", "alternative"]),
    research: pick(pickableEvents, ["research", "inspect", "read", "context", "reference"]),
    decisions: pick(pickableEvents, ["decide", "decision", "chose", "choose"]),
    unchallenged_assumptions: pick(pickableEvents, ["assume", "assumption"]),
    skipped_checks: [
      ...pick(pickableEvents, ["skip", "skipped", "not run", "could not"]),
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
    ...(source !== undefined ? { conversation_source: source } : {}),
    ...(collection.conversationDiscovery ? { conversation_discovery: collection.conversationDiscovery } : {})
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
const CLAIM_TEXT_LIMIT = 1200;
const EVENT_ID_LIMIT = 200;
const PICK_ENTRY_LIMIT = 500;

// An EDIT/WRITE tool-call — identified by its tool name OR (for adapters like Cursor
// that put `edit <file>: <body>` in the summary without a tool field) the summary's
// leading verb. Its summary is an embedded body, never a stated alternative, so it
// is excluded at ANY length — a short `edit src/x.ts: …context…` is noise, not
// research (Codex P2). A READ/inspect invocation is not matched.
const PICK_WRITE_PATTERN = /(?:edit|write|patch|replace|multiedit|create|update|insert|apply)/i;

function isEditOrWriteToolCall(event: ConversationEvent): boolean {
  if (event.tool !== undefined && PICK_WRITE_PATTERN.test(event.tool)) {
    return true;
  }
  return /^(?:edit|write|patch|replace|create|update|apply)\b/i.test(event.summary.trim());
}

// A turn worth keyword-picking. A tool_RESULT summary is always an output body, so
// it is excluded. A tool_CALL is kept ONLY when it is a SHORT, non-edit/write
// invocation — a bounded `Read(docs/goal.md)` IS research evidence (Codex P2), while
// an edit/write payload (any length) is the noise dogfooding caught. Every other
// (loose) kind is natural language and kept (no whitelist — Codex P2).
function pickableText(event: ConversationEvent): string | undefined {
  if (event.actor === "system" || event.actor === "developer" || event.actor === "tool") {
    return undefined;
  }
  if (isToolOutputEvent(event)) {
    return undefined;
  }
  if (isToolCallEvent(event)) {
    return event.summary.length <= PICK_TEXT_LIMIT && !isEditOrWriteToolCall(event)
      ? event.summary
      : undefined;
  }
  const text = conversationReviewerText(event.summary).trim();
  return text.length > 0 && !conversationEventLooksLikeGeneratedPayload(text) ? text : undefined;
}

interface PickableEvent {
  event: ConversationEvent;
  text: string;
  lowerText: string;
}

function preparePickableEvents(events: ConversationEvent[]): PickableEvent[] {
  const result: PickableEvent[] = [];
  for (const event of events) {
    const text = pickableText(event);
    if (text !== undefined) result.push({ event, text, lowerText: text.toLowerCase() });
  }
  return result;
}

// Bound the kept text to PICK_TEXT_LIMIT, keeping the window around the FIRST keyword
// match so the truncation still shows WHY the entry was picked (Codex P3).
function boundPickText(summary: string, lowerSummary: string, keywords: string[]): string {
  if (summary.length <= PICK_TEXT_LIMIT) {
    return summary;
  }
  const matchIndex = keywords
    .map((keyword) => lowerSummary.indexOf(keyword))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = matchIndex === undefined ? 0 : Math.max(0, matchIndex - 40);
  const slice = summary.slice(start, start + PICK_TEXT_LIMIT).trim();
  return `${start > 0 ? "…" : ""}${slice}…`;
}

function pick(events: PickableEvent[], keywords: string[]): string[] {
  const result: string[] = [];
  for (const { event, text, lowerText } of events) {
    if (result.length >= 12) {
      break;
    }
    if (keywords.some((keyword) => lowerText.includes(keyword))) {
      result.push(boundedEventEntry(event, boundPickText(text, lowerText, keywords), PICK_ENTRY_LIMIT));
    }
  }
  return result;
}

interface ValidationClaimCandidate {
  evidenceText: string;
  persistedText: string;
}

function pickValidationClaims(events: ConversationEvent[]): ValidationClaimCandidate[] {
  const result: ValidationClaimCandidate[] = [];
  for (const event of events) {
    if (!isValidationClaimEvent(event)) {
      continue;
    }
    if (isValidationSuccessClaim(event.summary) || isValidationFailureClaim(event.summary)) {
      result.push({
        evidenceText: event.summary,
        persistedText: boundedEventEntry(event, event.summary, CLAIM_TEXT_LIMIT)
      });
    }
  }
  return result;
}

function isValidationClaimEvent(event: ConversationEvent): boolean {
  if (event.actor !== "assistant" && event.actor !== "agent") {
    return false;
  }
  return !isToolCallEvent(event) &&
    !isToolOutputEvent(event) &&
    !conversationEventLooksLikeGeneratedPayload(event.summary);
}

function isToolCallEvent(event: ConversationEvent): boolean {
  return isConversationToolCall(event);
}

function isToolOutputEvent(event: ConversationEvent): boolean {
  return isConversationToolOutput(event);
}

function boundedEventEntry(event: ConversationEvent, summary: string, limit: number): string {
  const id = event.id.slice(0, EVENT_ID_LIMIT);
  const prefix = `${id}: `;
  const available = Math.max(0, limit - prefix.length - 1);
  return summary.length <= available
    ? `${prefix}${summary}`
    : `${prefix}${summary.slice(0, available).trimEnd()}…`;
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
    passed: new Map(),
    failed: new Map()
  };
  for (const transcript of collection.commandTranscripts ?? []) {
    const command = normalizeCommand(transcript.command);
    if (transcript.status === "passed" && transcript.exit_code === 0) {
      appendCommandTranscriptId(evidence.passed, command, transcript.id);
    } else if (transcript.status === "failed" || (typeof transcript.exit_code === "number" && transcript.exit_code !== 0)) {
      appendCommandTranscriptId(evidence.failed, command, transcript.id);
    }
  }
  return evidence;
}

function appendCommandTranscriptId(index: Map<string, string[]>, command: string, transcriptId: string): void {
  const existing = index.get(command);
  if (existing) {
    existing.push(transcriptId);
  } else {
    index.set(command, [transcriptId]);
  }
}

function claimCommandEvidenceIds(claim: string, transcriptCommands: TranscriptCommandEvidence): string[] | undefined {
  const claimedCommands = extractClaimedCommands(claim);
  if (claimedCommands.length === 0) {
    return undefined;
  }
  let evidenceIndex: Map<string, string[]> | undefined;
  if (isValidationSuccessClaim(claim)) {
    evidenceIndex = transcriptCommands.passed;
  } else if (isValidationFailureClaim(claim)) {
    evidenceIndex = transcriptCommands.failed;
  }
  if (!evidenceIndex || !claimedCommands.every((command) => evidenceIndex.has(command))) {
    return undefined;
  }
  const transcriptIds = new Set<string>();
  for (const command of claimedCommands) {
    for (const transcriptId of evidenceIndex.get(command) ?? []) {
      transcriptIds.add(transcriptId);
      if (transcriptIds.size === 5) {
        return [...transcriptIds];
      }
    }
  }
  return [...transcriptIds];
}

function withCommandEvidenceReference(claim: string, transcriptIds: string[]): string {
  const references = transcriptIds.slice(0, 5).map((id) => id.slice(0, EVENT_ID_LIMIT)).join(", ");
  const suffix = ` [command transcript: ${references}]`;
  const available = Math.max(0, CLAIM_TEXT_LIMIT - suffix.length - 1);
  const boundedClaim = claim.length <= available ? claim : `${claim.slice(0, available).trimEnd()}…`;
  return `${boundedClaim}${suffix}`;
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

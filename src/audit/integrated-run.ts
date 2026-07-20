import fs from "node:fs";
import path from "node:path";
import type { CollectionResult } from "../collector/collect";
import { parseStructuredDiff } from "../collector/diff-hunks";
import { isGitAncestor } from "../collector/git";
import type { ReasoningProvider } from "../contracts/provider";
import {
  AGREEMENT_AUDIT_INPUT_VERSION,
  AGREEMENT_AUDIT_RESULT_VERSION,
  type AgreementAudit,
  type AgreementAuditCandidate,
  type AgreementAuditInput,
  type AgreementCompletenessCandidate,
  type AuditConversationEvent,
  type ComparableAgreementAudit,
  type ConversationScopeStatus
} from "./contract";
import { compareAgreementAuditDecisions } from "./comparison";
import { groundAgreementAudit } from "./grounding";
import {
  parseAgreementAuditCandidate,
  parseAgreementAuditInput,
  parseAgreementCompletenessCandidate
} from "./parse";
import {
  AGREEMENT_CANDIDATE_SCHEMA,
  AGREEMENT_COMPLETENESS_SCHEMA,
  buildAuditPrompt,
  buildCompletenessPrompt
} from "./prompt";
import { clearAgreementAuditWorkingArtifacts, writePrivateJson } from "./artifacts";

const AUDIT_ACTORS = new Set(["user", "assistant", "agent", "tool"]);

export interface IntegratedAgreementAuditOptions {
  collection: CollectionResult;
  provider: ReasoningProvider;
  explicitConversationScope?: ConversationScopeStatus;
  extractionConfirmationToken?: string;
  previousAudit?: ComparableAgreementAudit;
}

export async function runIntegratedAgreementAudit(
  options: IntegratedAgreementAuditOptions
): Promise<AgreementAudit> {
  const previousAudit = options.previousAudit;
  if (previousAudit && !isGitAncestor(
    options.collection.cwd,
    previousAudit.head_sha,
    options.collection.manifest.head_sha
  )) {
    throw new Error("--previous-audit head must be an ancestor of the reviewed head");
  }
  const confirmedLedgers = options.extractionConfirmationToken ? {
    candidate: parseAgreementAuditCandidate(readAuditArtifact(options.collection.outputDir, "agreement-audit-candidate.json")),
    completeness: parseAgreementCompletenessCandidate(readAuditArtifact(options.collection.outputDir, "agreement-audit-completeness.json"))
  } : undefined;
  clearAgreementAuditWorkingArtifacts(options.collection.outputDir);
  if (!hasAuditableConversation(options.collection)) {
    return incompleteAgreementAudit(
      options,
      "No auditable conversation was collected; pass --conversation <path> or enable and fix auto-discovery."
    );
  }
  const input = buildCollectedAgreementAuditInput(options.collection, options.explicitConversationScope);
  writePrivateJson(path.join(options.collection.outputDir, "agreement-audit-input.json"), input);

  let candidate: AgreementAuditCandidate;
  if (confirmedLedgers) {
    candidate = confirmedLedgers.candidate;
  } else {
    const generated = await generateAgreementCandidate(options, input);
    if (!generated.ok) return incompleteAgreementAudit(options, generated.limitation, input);
    candidate = generated.candidate;
  }
  writePrivateJson(path.join(options.collection.outputDir, "agreement-audit-candidate.json"), candidate);

  let completeness: AgreementCompletenessCandidate | undefined = confirmedLedgers?.completeness;
  let completenessLimitation: string | undefined;
  if (!confirmedLedgers) {
    const completenessResult = await options.provider.generateStructured(
      "agreement-completeness",
      buildCompletenessPrompt(input, candidate),
      AGREEMENT_COMPLETENESS_SCHEMA,
      { remotePrivacyBlocked: options.collection.privacy.remote_provider_blocked }
    );
    if (completenessResult.ok) {
      try {
        completeness = parseAgreementCompletenessCandidate(completenessResult.data);
      } catch {
        completenessLimitation = "The separate completeness pass returned invalid output, so a clean result cannot be verified.";
      }
    } else {
      completenessLimitation = `The separate completeness pass was unavailable (${completenessResult.reason}), so a clean result cannot be verified.`;
    }
  }
  if (completeness) {
    writePrivateJson(path.join(options.collection.outputDir, "agreement-audit-completeness.json"), completeness);
  }

  const audit = groundAgreementAudit(input, {
    ...candidate,
    limitations: completenessLimitation
      ? [...candidate.limitations, completenessLimitation]
      : candidate.limitations
  }, completeness, options.extractionConfirmationToken);

  if (previousAudit) {
    audit.comparison = compareAgreementAuditDecisions(audit, previousAudit);
  }
  return audit;
}

async function generateAgreementCandidate(
  options: IntegratedAgreementAuditOptions,
  input: AgreementAuditInput
): Promise<
  { ok: true; candidate: AgreementAuditCandidate } |
  { ok: false; limitation: string }
> {
  if (options.provider.name === "ai-sdk" && options.collection.privacy.remote_provider_blocked) {
    return {
      ok: false,
      limitation: "Agreement extraction was blocked because the collected evidence contains high-risk secret material. Collected input remains in agreement-audit-input.json."
    };
  }
  let prompt: string;
  try {
    prompt = buildAuditPrompt(input, "review-surfaces");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/secret material/iu.test(message)) {
      return {
        ok: false,
        limitation: "Agreement extraction was blocked because the collected evidence contains high-risk secret material. Collected input remains in agreement-audit-input.json."
      };
    }
    throw error;
  }
  const result = await options.provider.generateStructured(
    "agreement-audit",
    prompt,
    AGREEMENT_CANDIDATE_SCHEMA,
    { remotePrivacyBlocked: options.collection.privacy.remote_provider_blocked }
  );
  if (!result.ok) {
    const explanation = result.reason === "privacy_block"
      ? "Agreement extraction was blocked because the collected evidence contains high-risk secret material."
      : `Agreement extraction was unavailable (${result.reason}).`;
    return {
      ok: false,
      limitation: `${explanation} Collected input remains in agreement-audit-input.json.`
    };
  }
  return { ok: true, candidate: parseAgreementAuditCandidate(result.data) };
}

function hasAuditableConversation(collection: CollectionResult): boolean {
  return collectedConversationSources(collection).some((source) =>
    source.events.some((event) => isAuditableConversationActor(event.actor))
  );
}

function incompleteAgreementAudit(
  options: IntegratedAgreementAuditOptions,
  limitation: string,
  input?: AgreementAuditInput
): AgreementAudit {
  const baseSha = input?.base_sha ?? options.collection.mergeBaseSha;
  const headSha = input?.head_sha ?? options.collection.manifest.head_sha;
  if (!baseSha || !/^[a-f0-9]{40}$/iu.test(headSha)) {
    throw new Error("agreement audit could not resolve the exact merge-base and head SHAs");
  }
  const sources = input?.conversation.sources ?? conversationSourceReferences(options.collection);
  const conversationStatus = sources.length === 0
    ? "missing" as const
    : input?.conversation.status ?? options.explicitConversationScope ?? "partial";
  const audit: AgreementAudit = {
    version: AGREEMENT_AUDIT_RESULT_VERSION,
    repository: input?.repository ?? options.collection.git.repo,
    base_sha: baseSha,
    head_sha: headSha,
    status: "cannot_audit",
    candidate_complete: false,
    completeness: {
      verified: false,
      structurally_verified: false,
      operator_confirmed: false,
      dispositions: [],
      limitations: [limitation],
      rejections: []
    },
    final_goal: null,
    agreements: [],
    conversation: {
      status: conversationStatus,
      sources,
      caveat: limitation
    },
    limitations: [limitation],
    rejections: []
  };
  if (options.previousAudit) {
    audit.comparison = compareAgreementAuditDecisions(audit, options.previousAudit);
  }
  return audit;
}

function readAuditArtifact(outputDir: string, name: string): unknown {
  const file = path.join(outputDir, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`--confirm-extraction requires the prior ${name} artifact; run audit once and review its ledgers first`);
  }
}

export function buildCollectedAgreementAuditInput(
  collection: CollectionResult,
  explicitConversationScope?: ConversationScopeStatus
): AgreementAuditInput {
  if (collection.diff_source !== "range") {
    throw new Error("agreement audit requires a resolved base...head range");
  }
  if (collection.manifest.uncommitted_files > 0) {
    throw new Error("agreement audit requires a clean working tree or an explicitly pinned --head so every evidence link names immutable bytes");
  }
  const events = mapConversationEvents(collection);
  const sources = conversationSourceReferences(collection);
  if (events.length === 0 || sources.length === 0) {
    throw new Error("no auditable conversation was collected; pass --conversation <path> or fix auto-discovery");
  }
  const discovered = collection.conversationDiscovery?.status === "admitted";
  // Discovery can identify a likely producing session, but it cannot prove that
  // no earlier or later session contains a governing correction. Completeness is
  // therefore always an explicit operator assertion.
  const status = explicitConversationScope ?? "partial";
  const baseSha = collection.mergeBaseSha;
  if (!baseSha || !/^[a-f0-9]{40}$/iu.test(collection.manifest.head_sha)) {
    throw new Error("agreement audit could not resolve the exact merge-base and head SHAs");
  }
  if (collection.reviewedDiff === undefined) {
    throw new Error("agreement audit requires the collector's immutable reviewed diff snapshot");
  }
  const structured = parseStructuredDiff(collection.reviewedDiff);
  const diff = structured.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((line) => ({
    path: line.kind === "delete" && file.old_path ? file.old_path : file.path,
    side: line.kind,
    line: line.kind === "delete" ? line.old_line! : line.new_line!,
    text: line.text
  }))));

  return parseAgreementAuditInput({
    version: AGREEMENT_AUDIT_INPUT_VERSION,
    repository: collection.git.repo,
    base_sha: baseSha,
    head_sha: collection.manifest.head_sha,
    conversation: {
      status,
      sources,
      events,
      caveat: status === "complete"
        ? "The operator asserted that the selected conversation sources contain every governing session."
        : explicitConversationScope
          ? "The selected conversation scope was explicitly marked incomplete."
          : discovered
            ? "Auto-discovery identified a likely producing session but cannot prove that no other governing session exists; pass --conversation-scope complete only after checking the full session scope."
            : "An explicit transcript was supplied but not asserted complete; pass --conversation-scope complete only after confirming it contains every governing session."
    },
    diff,
    commands: collection.commandTranscripts.map((command) => ({
      id: command.id,
      command: command.command,
      status: command.status,
      ...(command.head_sha ? { head_sha: command.head_sha } : {})
    }))
  });
}

function mapConversationEvents(collection: CollectionResult): AuditConversationEvent[] {
  return collectedConversationSources(collection).flatMap((source) => source.events
    .filter((event) => isAuditableConversationActor(event.actor))
    .map((event) => ({ source, event })))
    .map(({ source, event }, order) => ({
      id: event.id,
      source_id: source.id,
      actor: normalizeActor(event.actor),
      kind: event.kind,
      text: event.summary,
      order
    }));
}

type CollectedConversationSource = NonNullable<CollectionResult["conversationSources"]>[number];

function collectedConversationSources(collection: CollectionResult): CollectedConversationSource[] {
  if (collection.conversationSources?.length) return collection.conversationSources;
  if (!collection.conversationSourceHash || !collection.conversationEvents) return [];
  return [{
    id: "conversation-1",
    sha256: collection.conversationSourceHash,
    selection: collection.conversationDiscovery?.status === "admitted" ? "discovered" : "explicit",
    adapter: collection.conversationSource ?? "normalized",
    events: collection.conversationEvents
  }];
}

function conversationSourceReferences(collection: CollectionResult): AgreementAuditInput["conversation"]["sources"] {
  return collectedConversationSources(collection).map((source) => ({
    id: source.id,
    sha256: source.sha256,
    selection: source.selection
  }));
}

function isAuditableConversationActor(actor: string): boolean {
  return AUDIT_ACTORS.has(actor.toLowerCase());
}

function normalizeActor(actor: string): AuditConversationEvent["actor"] {
  const normalized = actor.toLowerCase();
  if (normalized === "user" || normalized === "assistant" || normalized === "agent") return normalized;
  return "tool";
}

import path from "node:path";
import { AGREEMENT_AUDIT_ARTIFACTS } from "../artifacts/agreement-audit";
import type { CollectionResult } from "../collector/collect";
import { parseStructuredDiff } from "../collector/diff-hunks";
import { isGitAncestor } from "../collector/git";
import type { ReasoningProvider } from "../contracts/provider";
import { ExitCodes } from "../core/exit-codes";
import { providerMakesRemoteCall } from "../llm/provider";
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
import { readAgreementAuditLedgers, type AgreementAuditLedgers } from "./ledgers";
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

export interface IntegratedAgreementAuditResult {
  audit: AgreementAudit;
  privacyBlocked: boolean;
}

export function integratedAgreementAuditExitCode(result: IntegratedAgreementAuditResult): number {
  if (result.privacyBlocked) return ExitCodes.privacyBlocked;
  return result.audit.status === "cannot_audit"
    ? ExitCodes.evidenceValidationFailed
    : ExitCodes.success;
}

export async function runIntegratedAgreementAudit(
  options: IntegratedAgreementAuditOptions
): Promise<IntegratedAgreementAuditResult> {
  const remoteProvider = providerMakesRemoteCall(options.provider.name);
  const previousAudit = options.previousAudit;
  if (previousAudit && !isGitAncestor(
    options.collection.cwd,
    previousAudit.head_sha,
    options.collection.manifest.head_sha
  )) {
    throw new Error("--previous-audit head must be an ancestor of the reviewed head");
  }
  let confirmedLedgers: AgreementAuditLedgers | undefined;
  if (options.extractionConfirmationToken) {
    try {
      confirmedLedgers = readAgreementAuditLedgers(
        path.join(options.collection.outputDir, AGREEMENT_AUDIT_ARTIFACTS.candidate),
        path.join(options.collection.outputDir, AGREEMENT_AUDIT_ARTIFACTS.completeness)
      );
    } catch {
      throw new Error(
        `--confirm-extraction requires the prior ${AGREEMENT_AUDIT_ARTIFACTS.candidate} and ` +
        `${AGREEMENT_AUDIT_ARTIFACTS.completeness} artifacts; run audit once and review its ledgers first`
      );
    }
  }
  if (!confirmedLedgers) clearAgreementAuditWorkingArtifacts(options.collection.outputDir);
  if (!hasAuditableConversation(options.collection)) {
    return {
      audit: incompleteAgreementAudit(
        options,
        "No auditable conversation was collected; pass --conversation <path> or enable and fix auto-discovery."
      ),
      privacyBlocked: false
    };
  }
  const input = buildCollectedAgreementAuditInput(options.collection, options.explicitConversationScope);
  writePrivateJson(path.join(options.collection.outputDir, AGREEMENT_AUDIT_ARTIFACTS.input), input);

  let candidate: AgreementAuditCandidate;
  let candidateBytes: string | undefined;
  if (confirmedLedgers) {
    candidate = confirmedLedgers.candidate;
  } else {
    const generated = await generateAgreementCandidate(options, input, remoteProvider);
    if (!generated.ok) {
      return {
        audit: incompleteAgreementAudit(options, generated.limitation, input),
        privacyBlocked: generated.privacyBlocked
      };
    }
    candidate = generated.candidate;
  }
  if (!confirmedLedgers) {
    candidateBytes = writePrivateJson(
      path.join(options.collection.outputDir, AGREEMENT_AUDIT_ARTIFACTS.candidate),
      candidate
    );
  }

  let completeness: AgreementCompletenessCandidate | undefined = confirmedLedgers?.completeness;
  let completenessBytes: string | undefined;
  let completenessLimitation: string | undefined;
  let completenessPrivacyBlocked = false;
  if (!confirmedLedgers) {
    try {
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
        completenessPrivacyBlocked = remoteProvider && completenessResult.reason === "privacy_block";
        completenessLimitation = completenessPrivacyBlocked
          ? "The separate completeness pass was blocked because its prompt contains high-risk secret material, so a clean result cannot be verified."
          : `The separate completeness pass was unavailable (${completenessResult.reason}), so a clean result cannot be verified.`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/secret material/iu.test(message)) throw error;
      completenessPrivacyBlocked = remoteProvider;
      completenessLimitation = "The separate completeness pass was blocked because its prompt contains high-risk secret material, so a clean result cannot be verified.";
    }
  }
  if (completeness && !confirmedLedgers) {
    completenessBytes = writePrivateJson(
      path.join(options.collection.outputDir, AGREEMENT_AUDIT_ARTIFACTS.completeness),
      completeness
    );
  }

  const confirmationLedgerBytes = confirmedLedgers?.bytes ??
    (candidateBytes && completenessBytes ? {
      candidate: candidateBytes,
      completeness: completenessBytes
    } : undefined);
  const audit = groundAgreementAudit(input, {
    ...candidate,
    limitations: completenessLimitation
      ? [...candidate.limitations, completenessLimitation]
      : candidate.limitations
  }, completeness, options.extractionConfirmationToken, confirmationLedgerBytes);

  if (previousAudit) {
    audit.comparison = compareAgreementAuditDecisions(audit, previousAudit);
  }
  return { audit, privacyBlocked: completenessPrivacyBlocked };
}

async function generateAgreementCandidate(
  options: IntegratedAgreementAuditOptions,
  input: AgreementAuditInput,
  remoteProvider: boolean
): Promise<
  { ok: true; candidate: AgreementAuditCandidate } |
  { ok: false; limitation: string; privacyBlocked: boolean }
> {
  if (remoteProvider && options.collection.privacy.remote_provider_blocked) {
    return {
      ok: false,
      privacyBlocked: true,
      limitation: "Agreement extraction was blocked because the collected evidence contains high-risk secret material. " +
        `Collected input remains in ${AGREEMENT_AUDIT_ARTIFACTS.input}.`
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
        privacyBlocked: remoteProvider,
        limitation: "Agreement extraction was blocked because the collected evidence contains high-risk secret material. " +
          `Collected input remains in ${AGREEMENT_AUDIT_ARTIFACTS.input}.`
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
      privacyBlocked: remoteProvider && result.reason === "privacy_block",
      limitation: `${explanation} Collected input remains in ${AGREEMENT_AUDIT_ARTIFACTS.input}.`
    };
  }
  return { ok: true, candidate: parseAgreementAuditCandidate(result.data) };
}

function hasAuditableConversation(collection: CollectionResult): boolean {
  return collectedConversationSources(collection).some((source) =>
    source.events.some(isAuditableConversationEvent)
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
    .filter(isAuditableConversationEvent)
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

function isAuditableConversationEvent(event: CollectedConversationSource["events"][number]): boolean {
  return isAuditableConversationActor(event.actor) && event.summary.trim().length > 0;
}

function normalizeActor(actor: string): AuditConversationEvent["actor"] {
  const normalized = actor.toLowerCase();
  if (normalized === "user" || normalized === "assistant" || normalized === "agent") return normalized;
  return "tool";
}

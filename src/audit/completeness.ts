import crypto from "node:crypto";
import {
  type AgreementAuditCandidate,
  type AgreementAuditInput,
  type AgreementCompletenessCandidate,
  type AgreementCompletenessResult
} from "./contract";
import { unique } from "../core/guards";

export function agreementCompletenessConfirmationToken(
  input: AgreementAuditInput,
  candidate: AgreementAuditCandidate,
  coverage: AgreementCompletenessCandidate
): string {
  return crypto.createHash("sha256").update(JSON.stringify({ input, candidate, coverage })).digest("hex");
}

/**
 * Validate the separate coverage pass against deterministic conversation and
 * candidate identities. The verifier may classify a turn, but it cannot invent
 * an event, agreement key, or represented relationship.
 */
export function verifyAgreementCompleteness(
  input: AgreementAuditInput,
  candidate: AgreementAuditCandidate,
  coverage: AgreementCompletenessCandidate | undefined
): Pick<AgreementCompletenessResult, "verified" | "dispositions" | "limitations" | "rejections"> {
  if (!coverage) {
    return {
      verified: false,
      dispositions: [],
      limitations: ["Agreement extraction completeness was not verified by the separate coverage pass; this decision list may not be exhaustive and a clean conclusion is unavailable."],
      rejections: []
    };
  }

  const rejections: string[] = [];
  const eligibleEvents = input.conversation.events.filter((event) =>
    event.actor === "user" || event.actor === "assistant" || event.actor === "agent"
  );
  const eligibleIds = new Set(eligibleEvents.map((event) => event.id));
  const agreements = new Map(candidate.agreements.map((agreement) => [agreement.key, agreement]));
  const agreementEventIds = new Map(candidate.agreements.map((agreement) => [
    agreement.key,
    new Set(agreement.conversation_event_ids)
  ]));
  const dispositionByEventId = new Map<string, AgreementCompletenessCandidate["dispositions"][number]>();
  const dispositionAgreementKeys = new Map<string, ReadonlySet<string>>();
  const seenEvents = new Set<string>();

  for (const agreement of candidate.agreements) {
    const representedEvents = [...new Set(agreement.conversation_event_ids)].filter((id) => eligibleIds.has(id));
    if (representedEvents.length > 1) {
      rejections.push(
        `agreement ${agreement.key} spans multiple auditable conversation events; split it into one atomic agreement per event`
      );
    }
  }

  for (const disposition of coverage.dispositions) {
    if (seenEvents.has(disposition.event_id)) {
      rejections.push(`conversation event ${disposition.event_id} has duplicate completeness dispositions`);
      continue;
    }
    seenEvents.add(disposition.event_id);
    dispositionByEventId.set(disposition.event_id, disposition);
    dispositionAgreementKeys.set(disposition.event_id, new Set(disposition.agreement_keys));
    if (!eligibleIds.has(disposition.event_id)) {
      rejections.push(`completeness disposition cites unknown or ineligible event ${disposition.event_id}`);
      continue;
    }
    if (disposition.disposition === "represented") {
      if (disposition.agreement_keys.length === 0) {
        rejections.push(`represented event ${disposition.event_id} has no agreement key`);
      }
      for (const key of new Set(disposition.agreement_keys)) {
        const agreement = agreements.get(key);
        if (!agreement) {
          rejections.push(`represented event ${disposition.event_id} cites unknown agreement ${key}`);
        } else if (!agreementEventIds.get(key)!.has(disposition.event_id)) {
          rejections.push(`agreement ${key} does not cite represented event ${disposition.event_id}`);
        }
      }
    } else {
      if (disposition.agreement_keys.length > 0) {
        rejections.push(`non-material event ${disposition.event_id} must not cite agreement keys`);
      }
      if (!disposition.reason?.trim()) {
        rejections.push(`non-material event ${disposition.event_id} needs a reason`);
      }
    }
  }

  for (const event of eligibleEvents) {
    if (!seenEvents.has(event.id)) {
      rejections.push(`eligible conversation event ${event.id} has no completeness disposition`);
    }
  }
  for (const agreement of candidate.agreements) {
    for (const eventId of new Set(agreement.conversation_event_ids)) {
      if (eligibleIds.has(eventId)) {
        const disposition = dispositionByEventId.get(eventId);
        if (disposition?.disposition !== "represented" ||
          !dispositionAgreementKeys.get(eventId)?.has(agreement.key)) {
          rejections.push(`agreement ${agreement.key} is not represented by the disposition for event ${eventId}`);
        }
      }
    }
  }
  if (!coverage.complete) rejections.push("the separate completeness pass did not finish");
  if (coverage.missing_agreements.length > 0) {
    rejections.push(`the separate pass found ${coverage.missing_agreements.length} missing agreement(s)`);
  }

  return {
    verified: rejections.length === 0 && coverage.limitations.length === 0,
    dispositions: coverage.dispositions,
    limitations: coverage.limitations,
    rejections: unique(rejections)
  };
}

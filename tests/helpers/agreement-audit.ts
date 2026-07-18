import fs from "node:fs";
import path from "node:path";
import type { AgreementAuditInput, AgreementCandidate } from "../../src/audit/contract";
import { parseAgreementAuditInput } from "../../src/audit/parse";

export const AGREEMENT_BENCH_ROOT = path.join(process.cwd(), "bench", "agreement");

export function loadAgreementInput(name: string): AgreementAuditInput {
  return parseAgreementAuditInput(readJson(path.join(AGREEMENT_BENCH_ROOT, "cases", `${name}.input.json`)));
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function agreementCandidate(
  overrides: Partial<AgreementCandidate> & Pick<AgreementCandidate, "key" | "statement">
): AgreementCandidate {
  return {
    kind: "human_instruction",
    state: "fulfilled",
    materiality: "material",
    conversation_event_ids: [],
    diff_citations: [],
    command_ids: [],
    ...overrides
  };
}

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { AgreementAuditLedgerBytes } from "./completeness";
import type { AgreementAuditCandidate, AgreementAuditInput, AgreementCompletenessCandidate } from "./contract";
import {
  parseAgreementAuditCandidate,
  parseAgreementAuditInput,
  parseAgreementCompletenessCandidate
} from "./parse";

export interface AgreementAuditLedgers {
  input: AgreementAuditInput;
  candidate: AgreementAuditCandidate;
  completeness: AgreementCompletenessCandidate;
  bytes: AgreementAuditLedgerBytes;
}

export function readAgreementAuditLedgers(
  inputFile: string,
  candidateFile: string,
  completenessFile: string,
  expectedInput?: AgreementAuditInput
): AgreementAuditLedgers | undefined {
  const inputBytes = readLedgerBytes(inputFile);
  const input = parseAgreementAuditInput(JSON.parse(inputBytes) as unknown);
  if (expectedInput && !isDeepStrictEqual(input, expectedInput)) return undefined;
  const candidateBytes = readLedgerBytes(candidateFile);
  const completenessBytes = readLedgerBytes(completenessFile);
  return {
    input: expectedInput ?? input,
    candidate: parseAgreementAuditCandidate(JSON.parse(candidateBytes) as unknown),
    completeness: parseAgreementCompletenessCandidate(JSON.parse(completenessBytes) as unknown),
    bytes: {
      input: inputBytes,
      candidate: candidateBytes,
      completeness: completenessBytes
    }
  };
}

function readLedgerBytes(file: string): string {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("agreement audit ledger must be a regular file");
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

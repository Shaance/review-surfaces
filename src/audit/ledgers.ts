import fs from "node:fs";
import type { AgreementAuditLedgerBytes } from "./completeness";
import type { AgreementAuditCandidate, AgreementCompletenessCandidate } from "./contract";
import { parseAgreementAuditCandidate, parseAgreementCompletenessCandidate } from "./parse";

export interface AgreementAuditLedgers {
  candidate: AgreementAuditCandidate;
  completeness: AgreementCompletenessCandidate;
  bytes: AgreementAuditLedgerBytes;
}

export function readAgreementAuditLedgers(
  candidateFile: string,
  completenessFile: string
): AgreementAuditLedgers {
  const candidateBytes = readLedgerBytes(candidateFile);
  const completenessBytes = readLedgerBytes(completenessFile);
  return {
    candidate: parseAgreementAuditCandidate(JSON.parse(candidateBytes) as unknown),
    completeness: parseAgreementCompletenessCandidate(JSON.parse(completenessBytes) as unknown),
    bytes: {
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

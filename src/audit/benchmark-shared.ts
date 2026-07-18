import crypto from "node:crypto";
import type { AgreementAudit } from "./contract";

export const AGREEMENT_BENCHMARK_VERSION = 2 as const;

export function agreementBenchmarkOutputHash(audit: AgreementAudit, markdown: string): string {
  const auditJson = JSON.stringify(audit);
  return crypto.createHash("sha256")
    .update("review-surfaces:agreement-benchmark-output:v1\0")
    .update(`${Buffer.byteLength(auditJson)}\0`)
    .update(auditJson)
    .update(`${Buffer.byteLength(markdown)}\0`)
    .update(markdown)
    .digest("hex");
}

export function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

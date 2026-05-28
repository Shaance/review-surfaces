import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileEvidence } from "../src/evidence/evidence";
import { validateEvidenceRef } from "../src/evidence/validate";

test("review-surfaces.EVIDENCE.3 rejects repository-escaping evidence paths", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-evidence-path-"));
  const outsidePath = path.relative(tmp, "/etc/hosts");
  const result = validateEvidenceRef(fileEvidence(outsidePath), { cwd: tmp });

  assert.equal(result.validation_status, "invalid");
  assert.match(result.note ?? "", /repository-relative/);
});

test("review-surfaces.EVIDENCE.3 validates line ranges without counting terminal newline as extra line", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-evidence-lines-"));
  fs.writeFileSync(path.join(tmp, "source.ts"), "one\ntwo\n");

  const valid = validateEvidenceRef({ ...fileEvidence("source.ts"), line_start: 2, line_end: 2 }, { cwd: tmp });
  const invalid = validateEvidenceRef({ ...fileEvidence("source.ts"), line_start: 3, line_end: 3 }, { cwd: tmp });

  assert.equal(valid.validation_status, "valid");
  assert.equal(invalid.validation_status, "invalid");
  assert.match(invalid.note ?? "", /line range/);
});

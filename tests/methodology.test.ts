import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMethodology } from "../src/methodology/methodology";

test("methodology marks missing conversation as not_provided", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const methodology = await buildMethodology(tmp, { outputDir: path.join(tmp, ".review-surfaces") } as any, undefined, []);

  assert.equal(methodology.missing_logs, true);
  assert.match(methodology.summary, /not_provided/);
});

test("methodology normalizes markdown conversation logs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(logPath, "Considered agent-file enrichment\nDecision: keep deterministic core\nSkipped AI smoke test\n");

  const methodology = await buildMethodology(
    tmp,
    { outputDir: path.join(tmp, ".review-surfaces") } as any,
    "conversation.md",
    ["pnpm run test"]
  );

  assert.equal(methodology.missing_logs, false);
  assert.ok(methodology.considered.length > 0);
  assert.ok(methodology.decisions.length > 0);
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "conversation.normalized.jsonl")));
});

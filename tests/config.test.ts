import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config";

test("loads local review-surfaces config", async () => {
  const config = await loadConfig(process.cwd());

  assert.equal(config.schema_version, "review-surfaces.config.v1");
  assert.equal(config.output_dir, ".review-surfaces");
  assert.deepEqual(config.specs, ["features/**/*.feature.yaml"]);
  assert.equal(config.llm.provider, "mock");
  assert.equal(config.dogfood.milestone, "M3");
});

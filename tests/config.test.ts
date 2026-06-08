import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, defaultConfig } from "../src/config/config";

test("review-surfaces.PROVIDERS.3 loads local review-surfaces config with mock as the default provider", async () => {
  const config = await loadConfig(process.cwd());

  assert.equal(config.schema_version, "review-surfaces.config.v1");
  assert.equal(config.output_dir, ".review-surfaces");
  assert.deepEqual(config.specs, ["features/**/*.feature.yaml"]);
  assert.equal(config.llm.provider, "mock");
  assert.equal(config.dogfood.milestone, "M5");
});

test("treats an empty or comment-only config file as defaults rather than an error", async () => {
  for (const contents of ["", "   \n  \n", "# only a comment\n"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-"));
    try {
      fs.writeFileSync(path.join(tmp, "review-surfaces.config.yaml"), contents);
      const config = await loadConfig(tmp);
      assert.deepEqual(config, defaultConfig);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test("review-surfaces.QUALITY.7 quality_gate.max_missing defaults to 0 and parses a valid override", async () => {
  assert.equal(defaultConfig.quality_gate.max_missing, 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-gate-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "review-surfaces.config.yaml"),
      "quality_gate:\n  max_missing: 3\n"
    );
    const config = await loadConfig(tmp);
    assert.equal(config.quality_gate.max_missing, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.QUALITY.7 quality_gate.max_missing rejects invalid values back to the default", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-gate-bad-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "review-surfaces.config.yaml"),
      "quality_gate:\n  max_missing: -2\n"
    );
    const config = await loadConfig(tmp);
    assert.equal(config.quality_gate.max_missing, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

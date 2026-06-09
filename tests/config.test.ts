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

test("review-surfaces.HUMAN_REVIEW.16 parses human_review caps and risk lens toggles", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-human-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "review-surfaces.config.yaml"),
      [
        "human_review:",
        "  enabled: false",
        "  default_entrypoint: false",
        "  max_review_first: 3",
        "  max_suggested_comments: 4",
        "  max_questions: 5",
        "  risk_lenses:",
        "    api_contract: false",
        "    security_privacy: true",
        "    llm_trust_boundary: false",
        "  required_manual_checks:",
        "    - id: workflow_secret_boundary",
        "      path_patterns:",
        "        - .github/workflows/**",
        "        - src/llm/provider*",
        "      prompt: Confirm PR-controlled code cannot access secrets."
      ].join("\n")
    );
    const config = await loadConfig(tmp);
    assert.equal(config.human_review.enabled, false);
    assert.equal(config.human_review.default_entrypoint, false);
    assert.equal(config.human_review.max_review_first, 3);
    assert.equal(config.human_review.max_suggested_comments, 4);
    assert.equal(config.human_review.max_questions, 5);
    assert.equal(config.human_review.risk_lenses.api_contract, false);
    assert.equal(config.human_review.risk_lenses.security_privacy, true);
    assert.equal(config.human_review.risk_lenses.llm_trust_boundary, false);
    assert.equal(config.human_review.risk_lenses.test_evidence, true);
    assert.deepEqual(config.human_review.required_manual_checks, [
      {
        id: "workflow_secret_boundary",
        path_patterns: [".github/workflows/**", "src/llm/provider*"],
        prompt: "Confirm PR-controlled code cannot access secrets."
      }
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.HUMAN_REVIEW.16 invalid human_review caps fall back to safe defaults", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-human-bad-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "review-surfaces.config.yaml"),
      [
        "human_review:",
        "  max_review_first: 0",
        "  max_suggested_comments: -1",
        "  max_questions: nope",
        "  risk_lenses:",
        "    api_contract: nope",
        "    security_privacy: false",
        "  required_manual_checks:",
        "    - id: missing_prompt",
        "      path_patterns:",
        "        - .github/workflows/**",
        "    - id: missing_paths",
        "      prompt: Confirm PR-controlled code cannot access secrets."
      ].join("\n")
    );
    const config = await loadConfig(tmp);
    assert.equal(config.human_review.max_review_first, defaultConfig.human_review.max_review_first);
    assert.equal(config.human_review.max_suggested_comments, defaultConfig.human_review.max_suggested_comments);
    assert.equal(config.human_review.max_questions, defaultConfig.human_review.max_questions);
    assert.equal(config.human_review.risk_lenses.api_contract, true);
    assert.equal(config.human_review.risk_lenses.security_privacy, false);
    assert.deepEqual(config.human_review.required_manual_checks, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

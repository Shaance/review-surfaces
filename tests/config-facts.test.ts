import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConfigFacts } from "../src/risks/config-facts";
import { parseStructuredDiff } from "../src/collector/diff-hunks";

function diffOf(file: string, added: string[], removed: string[] = []): ReturnType<typeof parseStructuredDiff> {
  return parseStructuredDiff(
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      `@@ -1,${removed.length} +1,${added.length} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`)
    ].join("\n")
  );
}

const NO_READ = () => undefined;

test("review-surfaces.CONFIG_FACTS.1 new and removed process.env references and env example keys are flagged", () => {
  const codeFacts = computeConfigFacts({
    diff: diffOf("src/server.ts", ['const url = process.env.API_URL;'], ['const old = process.env.OLD_FLAG;']),
    readBase: NO_READ,
    readHead: NO_READ
  });
  assert.ok(codeFacts.some((fact) => fact.kind === "env_var_added" && /`API_URL`/.test(fact.detail)));
  assert.ok(codeFacts.some((fact) => fact.kind === "env_var_removed" && /`OLD_FLAG`/.test(fact.detail)));

  const exampleFacts = computeConfigFacts({
    diff: diffOf(".env.example", ["NEW_KEY=value"], ["GONE_KEY=value"]),
    readBase: NO_READ,
    readHead: NO_READ
  });
  assert.ok(exampleFacts.some((fact) => fact.kind === "env_example_key_change" && /adds env example key `NEW_KEY`/.test(fact.detail)));
  assert.ok(exampleFacts.some((fact) => fact.kind === "env_example_key_change" && /removes env example key `GONE_KEY`/.test(fact.detail)));
});

test("review-surfaces.CONFIG_FACTS.2 workflow permission broadening, secrets, pull_request_target, and unpinned actions are flagged", () => {
  const basisYaml = "on: push\npermissions:\n  contents: read\njobs: {}\n";
  const headYaml = "on:\n  pull_request_target:\npermissions:\n  contents: write\njobs: {}\n";
  const facts = computeConfigFacts({
    diff: diffOf(
      ".github/workflows/deploy.yml",
      ["  pull_request_target:", "  contents: write", "      env: ${{ secrets.DEPLOY_KEY }}", "      uses: someone/action@v3"]
    ),
    readBase: () => basisYaml,
    readHead: () => headYaml
  });
  assert.ok(facts.some((fact) => fact.kind === "ci_permissions_broadened" && /contents: write/.test(fact.detail)));
  assert.ok(facts.some((fact) => fact.kind === "ci_new_secret_reference" && /`DEPLOY_KEY`/.test(fact.detail)));
  assert.ok(facts.some((fact) => fact.kind === "ci_pull_request_target_added"));
  assert.ok(facts.some((fact) => fact.kind === "ci_unpinned_action" && /someone\/action@v3/.test(fact.detail)));
  // The language flags for attention, not proof.
  assert.match(facts.find((fact) => fact.kind === "ci_permissions_broadened")!.detail, /flagged for attention/);
});

test("review-surfaces.CONFIG_FACTS.3 Dockerfile curl-pipe-shell, base image, dropped USER, and destructive SQL are flagged", () => {
  const dockerFacts = computeConfigFacts({
    diff: diffOf("Dockerfile", ["FROM node:22-alpine", "RUN curl -fsSL https://x.sh | sh"]),
    readBase: () => "FROM node:20\nUSER app\n",
    readHead: () => "FROM node:22-alpine\nRUN curl -fsSL https://x.sh | sh\n"
  });
  assert.ok(dockerFacts.some((fact) => fact.kind === "docker_curl_pipe_shell"));
  assert.ok(dockerFacts.some((fact) => fact.kind === "docker_base_image_changed"));
  assert.ok(dockerFacts.some((fact) => fact.kind === "docker_user_dropped"));

  const sqlFacts = computeConfigFacts({
    diff: diffOf("migrations/0002_drop.sql", ["DROP TABLE users;", "DELETE FROM sessions;"]),
    readBase: NO_READ,
    readHead: NO_READ
  });
  assert.equal(sqlFacts.filter((fact) => fact.kind === "sql_destructive_statement").length, 2);
  assert.match(sqlFacts[0].detail, /flagged for human attention/);
});

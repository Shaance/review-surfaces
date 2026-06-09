import test from "node:test";
import assert from "node:assert/strict";
import {
  commandLooksLikeBroadTestCommand,
  commandLooksLikeFocusedTestCommand,
  commandLooksLikeLocalValidationCommand,
  commandLooksLikeTestCommand,
  normalizeCommand
} from "../src/commands/classify";

test("review-surfaces.COLLECTOR.7 classifies broad and focused test commands", () => {
  assert.equal(normalizeCommand(" pnpm   run   test:fast "), "pnpm run test:fast");
  assert.equal(commandLooksLikeTestCommand("pnpm run test:fast"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run test:fast"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run test:fast"), false);

  assert.equal(commandLooksLikeTestCommand("node --test dist/tests/pr-risks.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test dist/tests/pr-risks.test.js"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test dist/tests/pr-risks.test.js"), true);

  assert.equal(commandLooksLikeTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run build"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm exec vitest"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run start"), false);
});

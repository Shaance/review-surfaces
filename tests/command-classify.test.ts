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
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run test:cov"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run test:cov"), false);
  assert.equal(commandLooksLikeTestCommand("pnpm run test:privacy"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run test:privacy"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run test:privacy"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm run test:unit:api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run test:unit:api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run test:unit:api"), true);

  assert.equal(commandLooksLikeTestCommand("node --test dist/tests/pr-risks.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test dist/tests/pr-risks.test.js"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test dist/tests/pr-risks.test.js"), true);
  assert.equal(commandLooksLikeTestCommand("node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeTestCommand("node --experimental-test-coverage --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --experimental-test-coverage --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --import=tsx --test tests/foo.test.ts"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --import tsx --test tests/foo.test.ts"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-name-pattern risk dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeTestCommand("node --test --test-reporter-destination tests/results.tap"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-reporter-destination tests/results.tap"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-reporter-destination tests/results.tap"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-reporter tap dist/tests/pr-risks.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-coverage-include src/foo.ts dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-coverage-exclude src/generated.ts dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test 'tests/risks/*.test.js'"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test 'tests/risks/*.test.js'"), false);
  assert.equal(commandLooksLikeTestCommand("pnpm exec vitest src/risks"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest src/risks"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest src/risks"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeTestCommand("pnpm exec vitest --workspace vitest.workspace.ts"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest --workspace vitest.workspace.ts"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest --workspace vitest.workspace.ts"), false);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest --config src/vitest.config.ts"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest --config src/vitest.config.ts"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("vitest --testNamePattern risk"), true);
  assert.equal(commandLooksLikeTestCommand("npm exec -- vitest src/risks"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("npm exec -- vitest src/risks"), true);
  assert.equal(commandLooksLikeTestCommand("npm exec -- node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm exec -- node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("npm exec -- node --test tests/foo.test.ts"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm --filter api exec node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm --filter api test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm --filter api test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm --filter api test"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm --filter api run test:fast"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm --filter api run test:fast"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm --filter api run test:fast"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm -F api exec vitest"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm -F api exec vitest"), true);
  assert.equal(commandLooksLikeTestCommand("yarn workspace api test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn workspace api test"), true);
  assert.equal(commandLooksLikeTestCommand("npm run test -w api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm run test -w api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("npm run test -w api"), true);
  assert.equal(commandLooksLikeTestCommand("npm test --workspace api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm test --workspace api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("npm test --workspace api"), true);
  assert.equal(commandLooksLikeTestCommand("npm -w api test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("npm -w api test"), true);

  assert.equal(commandLooksLikeTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run build"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm --filter api build"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm exec vitest"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run start"), false);
});

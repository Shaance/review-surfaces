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
  assert.equal(commandLooksLikeTestCommand("pnpm run --if-present test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run --if-present test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run --if-present test"), false);
  assert.equal(commandLooksLikeTestCommand("pnpm run --if-present test:privacy"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run --if-present test:privacy"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run --if-present test:privacy"), true);
  assert.equal(commandLooksLikeTestCommand("npm run-script test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm run-script test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("npm run-script test"), false);
  assert.equal(commandLooksLikeTestCommand("npm run-script --if-present test:privacy"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm run-script --if-present test:privacy"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("npm run-script --if-present test:privacy"), true);
  assert.equal(commandLooksLikeTestCommand("CI=1 pnpm run test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("CI=1 pnpm run test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("CI=1 pnpm run test"), false);
  assert.equal(commandLooksLikeTestCommand("NODE_OPTIONS=--conditions=test node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("NODE_OPTIONS=--conditions=test node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("NODE_OPTIONS=--conditions=test node --test dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeTestCommand("NODE_OPTIONS='--conditions=test --import=tsx' node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("NODE_OPTIONS='--conditions=test --import=tsx' node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("NODE_OPTIONS='--conditions=test --import=tsx' node --test dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeTestCommand("pnpm run test -- --config tests/jest.config.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run test -- --config tests/jest.config.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run test -- --config tests/jest.config.js"), false);
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
  assert.equal(commandLooksLikeTestCommand("node --test-name-pattern risk --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test-name-pattern risk --test dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test-name-pattern risk --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-name-pattern risk dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeTestCommand("node --test --test-shard=1/4"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-shard=1/4"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-shard=1/4"), true);
  assert.equal(commandLooksLikeTestCommand("node --test --test-shard 1/4"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-shard 1/4"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-shard 1/4"), true);
  assert.equal(commandLooksLikeTestCommand("node --test-shard=1/4 --test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test-shard=1/4 --test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test-shard=1/4 --test"), true);
  assert.equal(commandLooksLikeTestCommand("node --test --test-only"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-only"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-only"), true);
  assert.equal(commandLooksLikeTestCommand("node --test --test-skip-pattern slow"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-skip-pattern slow"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-skip-pattern slow"), true);
  assert.equal(commandLooksLikeTestCommand("node --test-skip-pattern=slow --test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test-skip-pattern=slow --test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test-skip-pattern=slow --test"), true);
  assert.equal(commandLooksLikeTestCommand("node --test \"**/*.test.js\""), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test \"**/*.test.js\""), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test \"**/*.test.js\""), false);
  assert.equal(commandLooksLikeTestCommand("node --test \"test/**/*.test.js\""), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test \"test/**/*.test.js\""), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test \"test/**/*.test.js\""), false);
  assert.equal(commandLooksLikeTestCommand("node --test --test-reporter-destination tests/results.tap"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-reporter-destination tests/results.tap"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-reporter-destination tests/results.tap"), false);
  assert.equal(commandLooksLikeTestCommand("node --test --test-global-setup tests/setup.mjs dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-global-setup tests/setup.mjs dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-global-setup tests/setup.mjs dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-reporter tap dist/tests/pr-risks.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test --test-coverage-include src/foo.ts dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test --test-coverage-exclude src/generated.ts dist/tests/*.test.js"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test 'tests/risks/*.test.js'"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test 'tests/risks/*.test.js'"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("node --test 'test/risks/*.test.js'"), true);
  assert.equal(commandLooksLikeBroadTestCommand("node --test 'test/risks/*.test.js'"), false);
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
  assert.equal(commandLooksLikeTestCommand("pnpm exec vitest --dir src/risks"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest --dir src/risks"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest --dir src/risks"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm exec vitest --dir=src/risks"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest --dir=src/risks"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest --dir=src/risks"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm exec vitest --dir=./src/risks"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest --dir=./src/risks"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest --dir=./src/risks"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm vitest"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm vitest"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm vitest"), false);
  assert.equal(commandLooksLikeTestCommand("yarn vitest src/risks"), true);
  assert.equal(commandLooksLikeBroadTestCommand("yarn vitest src/risks"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn vitest src/risks"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm exec vitest --project api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest --project api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest --project api"), true);
  assert.equal(commandLooksLikeTestCommand("jest --selectProjects api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("jest --selectProjects api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("jest --selectProjects api"), true);
  assert.equal(commandLooksLikeTestCommand("jest --testPathPattern=tests/api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("jest --testPathPattern=tests/api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("jest --testPathPattern=tests/api"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm exec jest --testPathPatterns tests/api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec jest --testPathPatterns tests/api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec jest --testPathPatterns tests/api"), true);
  assert.equal(commandLooksLikeTestCommand("jest --onlyChanged"), true);
  assert.equal(commandLooksLikeBroadTestCommand("jest --onlyChanged"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("jest --onlyChanged"), true);
  assert.equal(commandLooksLikeTestCommand("jest -o"), true);
  assert.equal(commandLooksLikeBroadTestCommand("jest -o"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("jest -o"), true);
  assert.equal(commandLooksLikeTestCommand("jest --changedSince main"), true);
  assert.equal(commandLooksLikeBroadTestCommand("jest --changedSince main"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("jest --changedSince main"), true);
  assert.equal(commandLooksLikeTestCommand("vitest --changed HEAD~1"), true);
  assert.equal(commandLooksLikeBroadTestCommand("vitest --changed HEAD~1"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("vitest --changed HEAD~1"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm exec vitest --changed"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm exec vitest --changed"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm exec vitest --changed"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("vitest --testNamePattern risk"), true);
  assert.equal(commandLooksLikeTestCommand("npm exec -- vitest src/risks"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("npm exec -- vitest src/risks"), true);
  assert.equal(commandLooksLikeTestCommand("npm exec -- node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm exec -- node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("npm exec -- node --test tests/foo.test.ts"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm --filter api exec node --test dist/tests/*.test.js"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm --dir services/api test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm --dir services/api test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm --dir services/api test"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm -C services/api test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm -C services/api test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm -C services/api test"), true);
  assert.equal(commandLooksLikeTestCommand("pnpm --dir . test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm --dir . test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm --dir . test"), false);
  assert.equal(commandLooksLikeTestCommand("pnpm -C ./ test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm -C ./ test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm -C ./ test"), false);
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
  assert.equal(commandLooksLikeTestCommand("yarn workspaces foreach -A run test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("yarn workspaces foreach -A run test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn workspaces foreach -A run test"), false);
  assert.equal(commandLooksLikeTestCommand("yarn workspaces foreach --include @app/api run test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("yarn workspaces foreach --include @app/api run test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn workspaces foreach --include @app/api run test"), true);
  assert.equal(commandLooksLikeTestCommand("yarn workspaces foreach --from @app/api run test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("yarn workspaces foreach --from @app/api run test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn workspaces foreach --from @app/api run test"), true);
  assert.equal(commandLooksLikeTestCommand("yarn workspaces foreach --since=origin/main run test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("yarn workspaces foreach --since=origin/main run test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn workspaces foreach --since=origin/main run test"), true);
  assert.equal(commandLooksLikeTestCommand("yarn workspaces foreach -A run test --include @app/api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("yarn workspaces foreach -A run test --include @app/api"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn workspaces foreach -A run test --include @app/api"), false);
  assert.equal(commandLooksLikeTestCommand("yarn workspaces run test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("yarn workspaces run test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("yarn workspaces run test"), false);
  assert.equal(commandLooksLikeTestCommand("npm run test -w api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm run test -w api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("npm run test -w api"), true);
  assert.equal(commandLooksLikeTestCommand("npm run --if-present test -w api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm run --if-present test -w api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("npm run --if-present test -w api"), true);
  assert.equal(commandLooksLikeTestCommand("npm test --workspace api"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm test --workspace api"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("npm test --workspace api"), true);
  assert.equal(commandLooksLikeTestCommand("npm -w api test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("npm -w api test"), true);
  assert.equal(commandLooksLikeTestCommand("npm --prefix services/api test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("npm --prefix services/api test"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("npm --prefix services/api test"), true);

  assert.equal(commandLooksLikeTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeBroadTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("pnpm run build"), false);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run build"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run build:fast"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run lint:fix"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run typecheck:ci"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("npm run-script build"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("npm run-script --if-present lint"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("npm run-script typecheck"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm --filter api build"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm exec vitest"), true);
  assert.equal(commandLooksLikeLocalValidationCommand("pnpm run start"), false);
});

test("review-surfaces.COLLECTOR.7 recognizes cross-ecosystem (non-JS) test runners", () => {
  // Broad whole-suite runs across ecosystems — recognized AND broad (so a passing
  // run suppresses the per-area test-gap risk on a non-Node repo).
  for (const broad of [
    "go test ./...",
    "go test",
    "cargo test",
    "cargo nextest run",
    "pytest",
    "py.test",
    "python -m pytest",
    "python3 -m pytest",
    "python3 -m unittest",
    "tox",
    "rspec",
    "rake test",
    "rake spec",
    "phpunit",
    "vendor/bin/phpunit",
    "./vendor/bin/phpunit",
    "pest",
    "mvn test",
    "mvn clean verify",
    "./mvnw test",
    "gradle test",
    "./gradlew test",
    "gradle build check",
    "dotnet test",
    "ctest",
    "mix test",
    "swift test",
    "dart test",
    "flutter test"
  ]) {
    assert.equal(commandLooksLikeTestCommand(broad), true, `recognize: ${broad}`);
    assert.equal(commandLooksLikeBroadTestCommand(broad), true, `broad: ${broad}`);
    assert.equal(commandLooksLikeFocusedTestCommand(broad), false, `not focused: ${broad}`);
    assert.equal(commandLooksLikeLocalValidationCommand(broad), true, `local validation: ${broad}`);
  }

  // Env-prefixed and launcher-prefixed forms still classify.
  assert.equal(commandLooksLikeBroadTestCommand("CI=1 go test ./..."), true);
  assert.equal(commandLooksLikeBroadTestCommand("bundle exec rspec"), true);
  assert.equal(commandLooksLikeTestCommand("poetry run pytest"), true);

  // Focused runs — an explicit filter flag or a specific test file/id.
  for (const focused of [
    "go test -run TestLogin ./auth",
    "cargo test --test integration_login",
    "pytest -k login",
    "pytest tests/test_auth.py",
    "pytest tests/test_auth.py::test_login",
    "python3 -m pytest tests/test_auth.py::test_login",
    "rspec spec/models/user_spec.rb",
    "rspec spec/models/user_spec.rb:42",
    "bundle exec rspec spec/models/user_spec.rb",
    "phpunit tests/UserTest.php",
    "phpunit --filter testLogin",
    "mvn -Dtest=UserTest test",
    "gradle test --tests com.example.UserTest",
    "dotnet test --filter Name=Login",
    "ctest -R login",
    "mix test test/user_test.exs",
    "swift test --filter LoginTests"
  ]) {
    assert.equal(commandLooksLikeTestCommand(focused), true, `recognize: ${focused}`);
    assert.equal(commandLooksLikeFocusedTestCommand(focused), true, `focused: ${focused}`);
    assert.equal(commandLooksLikeBroadTestCommand(focused), false, `not broad: ${focused}`);
  }

  // A bare TEST-ROOT directory stays broad (it runs the whole suite under it), but
  // an explicit Go package argument NARROWS the run, so it is focused (Codex P2).
  assert.equal(commandLooksLikeBroadTestCommand("pytest tests/"), true);
  assert.equal(commandLooksLikeBroadTestCommand("go test ./..."), true);
  assert.equal(commandLooksLikeFocusedTestCommand("go test ./pkg/auth"), true);
  assert.equal(commandLooksLikeBroadTestCommand("go test ./pkg/auth"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("cargo test login"), true);

  // A mere mention is not a test run (segment-start matching only).
  assert.equal(commandLooksLikeTestCommand("grep pytest pyproject.toml"), false);
  assert.equal(commandLooksLikeTestCommand("echo go test"), false);
  assert.equal(commandLooksLikeTestCommand("cat go.mod"), false);
  // -DskipTests is not a test goal.
  assert.equal(commandLooksLikeTestCommand("mvn deploy -DskipTests"), false);
});

test("review-surfaces.COLLECTOR.7 screens no-execution, excluded, and ambiguous cross-ecosystem invocations (Codex P2)", () => {
  // No-execution invocations don't run tests, so they must NOT be credited as a
  // (broad) test run that would suppress the per-area test-gap risk.
  for (const noExec of [
    "go test -list Test ./...",
    "cargo test --no-run",
    "pytest --collect-only",
    "ctest -N",
    "ctest --show-only"
  ]) {
    assert.equal(commandLooksLikeTestCommand(noExec), false, `no-execution: ${noExec}`);
    assert.equal(commandLooksLikeBroadTestCommand(noExec), false, `not broad: ${noExec}`);
  }

  // Excluding/skipping the test task is not a test run.
  assert.equal(commandLooksLikeTestCommand("gradle -x test check"), false);
  assert.equal(commandLooksLikeTestCommand("./gradlew check --exclude-task test"), false);
  assert.equal(commandLooksLikeTestCommand("mvn test -DskipTests"), false);
  assert.equal(commandLooksLikeTestCommand("mvn -Dmaven.test.skip=true verify"), false);
  // ...but excluding a DIFFERENT task while running tests is still a test run.
  assert.equal(commandLooksLikeBroadTestCommand("gradle test -x integrationTest"), true);

  // unittest discovery with a -p PATTERN is a BROAD suite run, not a focused file.
  assert.equal(commandLooksLikeBroadTestCommand("python3 -m unittest discover -p '*_test.py'"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("python3 -m unittest discover -p '*_test.py'"), false);
  // A glob target is a set, not a single focused test.
  assert.equal(commandLooksLikeBroadTestCommand("pytest tests/*_test.py"), true);

  // Maven -e is --errors (output), NOT a focus selector — a full-suite run stays broad.
  assert.equal(commandLooksLikeBroadTestCommand("mvn -e test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("mvn -e test"), false);
  // ...while rspec -e really is a focus selector.
  assert.equal(commandLooksLikeFocusedTestCommand("rspec -e \"signs in\""), true);
});

test("review-surfaces.COLLECTOR.7 cross-ecosystem monorepo/CI scope selectors (Codex P2 round 3)", () => {
  // Maven/Gradle/dotnet/unittest scoped selectors are FOCUSED, not whole-repo broad.
  assert.equal(commandLooksLikeFocusedTestCommand("mvn -pl api test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("mvn --projects api,web test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("./gradlew :api:test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("gradle test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("python3 -m unittest module.TestClass.test_method"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("dotnet test ./src/Foo.Tests/Foo.Tests.csproj"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("dotnet test MySolution.sln"), true);
  assert.equal(commandLooksLikeBroadTestCommand("dotnet test"), true);

  // Marker / short / skip selectors narrow the executed suite -> focused.
  assert.equal(commandLooksLikeFocusedTestCommand("pytest -m 'not slow'"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("go test -short ./..."), true);

  // -N is ctest-only: `mvn -N test` (--non-recursive) still RUNS tests -> broad.
  assert.equal(commandLooksLikeBroadTestCommand("mvn -N test"), true);
  assert.equal(commandLooksLikeTestCommand("ctest -N"), false);
  // -DskipTests=false RE-ENABLES tests; only a real skip drops the run.
  assert.equal(commandLooksLikeBroadTestCommand("mvn test -DskipTests=false"), true);
  assert.equal(commandLooksLikeTestCommand("mvn test -DskipTests"), false);

  // A value-option operand is not a cargo test-name filter -> stays broad.
  assert.equal(commandLooksLikeBroadTestCommand("cargo test --workspace --jobs 4"), true);
  // ...but a cargo package selector IS scoped -> focused.
  assert.equal(commandLooksLikeFocusedTestCommand("cargo test -p mycrate"), true);

  // tox/nox can run any session; an UNKNOWN session selector is scoped (focused) and
  // only a bare invocation is broad (a clearly non-test docs/lint session is screened
  // out entirely — see the round-5 test).
  assert.equal(commandLooksLikeBroadTestCommand("tox"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("tox -e py39"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("nox --sessions integration"), true);
  assert.equal(commandLooksLikeBroadTestCommand("tox -e py39"), false);

  // `gradle help --task test` prints task info, it does not run tests.
  assert.equal(commandLooksLikeTestCommand("gradle help --task test"), false);
});

test("review-surfaces.COLLECTOR.7 cross-ecosystem runner/flag vocabulary (Codex P2 round 4)", () => {
  // Launcher options before the wrapped runner are stripped (uv run [OPTIONS] CMD).
  assert.equal(commandLooksLikeBroadTestCommand("uv run --locked pytest"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("uv run --group dev pytest -k login"), true);

  // Help/version anywhere, and info subcommands behind global options, print & exit.
  assert.equal(commandLooksLikeTestCommand("gradle --help"), false);
  assert.equal(commandLooksLikeTestCommand("gradle --console=plain help"), false);
  assert.equal(commandLooksLikeTestCommand("swift test --help"), false);
  // ...but -v is verbose, not version — a real run.
  assert.equal(commandLooksLikeBroadTestCommand("go test -v ./..."), true);

  // Swift list-only invocations don't execute tests; a `list` filter value does.
  assert.equal(commandLooksLikeTestCommand("swift test --list-tests"), false);
  assert.equal(commandLooksLikeTestCommand("swift test list"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("swift test --filter list"), true);

  // Suite-exclusion / reduction filters are focused.
  assert.equal(commandLooksLikeFocusedTestCommand("go test -skip TestSlow ./..."), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pytest --deselect tests/test_x.py::test_y"), true);

  // Dart test files are specific targets.
  assert.equal(commandLooksLikeFocusedTestCommand("dart test test/widget_test.dart"), true);

  // A Go SUBTREE glob scopes to a prefix -> focused; only the whole-module glob is broad.
  assert.equal(commandLooksLikeFocusedTestCommand("go test ./pkg/..."), true);
  assert.equal(commandLooksLikeFocusedTestCommand("go test pkg/..."), true);
  assert.equal(commandLooksLikeBroadTestCommand("go test ./..."), true);

  // unittest discover scoped to a start directory is focused; bare discover is broad.
  assert.equal(commandLooksLikeFocusedTestCommand("python3 -m unittest discover -s tests/sub"), true);
  assert.equal(commandLooksLikeBroadTestCommand("python3 -m unittest discover"), true);
  assert.equal(commandLooksLikeBroadTestCommand("python3 -m unittest discover -s ."), true);
});

test("review-surfaces.COLLECTOR.7 cross-ecosystem goal scoping and no-exec aliases (Codex P2 round 5)", () => {
  // The JVM head matches a test PHASE/TASK token, not `test` inside a -D/-P value.
  assert.equal(commandLooksLikeTestCommand("mvn dependency:tree -Dincludes=junit:test"), false);
  assert.equal(commandLooksLikeTestCommand("gradle assemble -Penv=test"), false);
  assert.equal(commandLooksLikeBroadTestCommand("mvn clean test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("gradle :app:test"), true);

  // No-execution: compile/list/dry-run/version-only/short-alias don't run tests.
  assert.equal(commandLooksLikeTestCommand("go test -c ./..."), false);
  assert.equal(commandLooksLikeTestCommand("dotnet test --list-tests"), false);
  assert.equal(commandLooksLikeTestCommand("gradle test --dry-run"), false);
  assert.equal(commandLooksLikeTestCommand("gradle -m test"), false);
  assert.equal(commandLooksLikeTestCommand("mvn -v test"), false);
  assert.equal(commandLooksLikeTestCommand("gradle -v test"), false);
  assert.equal(commandLooksLikeTestCommand("pytest --co"), false);
  // ...but `go test -count 1` is a real run (not the compile-only `-c`).
  assert.equal(commandLooksLikeBroadTestCommand("go test -count 1 ./..."), true);

  // More focus selectors: cargo targets, pytest last-failed, ctest label/rerun.
  assert.equal(commandLooksLikeFocusedTestCommand("cargo test --lib"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("pytest --lf"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("ctest -L api"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("ctest --rerun-failed"), true);

  // go test . / ./ is the current package (focused); bare `go test` is broad.
  assert.equal(commandLooksLikeFocusedTestCommand("go test ."), true);
  assert.equal(commandLooksLikeBroadTestCommand("go test"), true);

  // unittest discover with a POSITIONAL start dir is focused; a -p pattern stays broad.
  assert.equal(commandLooksLikeFocusedTestCommand("python3 -m unittest discover tests/sub"), true);
  assert.equal(commandLooksLikeBroadTestCommand("python3 -m unittest discover -p '*_test.py'"), true);

  // A clearly non-test tox/nox session is not test evidence; an unknown session is
  // recognized-but-focused (bounded); a bare invocation is broad.
  assert.equal(commandLooksLikeTestCommand("nox -s lint"), false);
  assert.equal(commandLooksLikeTestCommand("tox -e docs"), false);
  assert.equal(commandLooksLikeFocusedTestCommand("tox -e py39"), true);
  assert.equal(commandLooksLikeBroadTestCommand("tox"), true);
});

test("review-surfaces.COLLECTOR.7 cross-ecosystem no-exec aliases and inline cargo selectors (Codex P2 round 6)", () => {
  // Inspection/version aliases don't execute tests.
  assert.equal(commandLooksLikeTestCommand("pytest -V"), false);
  assert.equal(commandLooksLikeTestCommand("pytest --setup-plan"), false);
  assert.equal(commandLooksLikeTestCommand("ctest -version"), false);
  assert.equal(commandLooksLikeTestCommand("ctest -help"), false);
  // The inline `--package=`/`-p=` cargo selector scopes to one package -> focused.
  assert.equal(commandLooksLikeFocusedTestCommand("cargo test --package=mycrate"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("cargo test -p mycrate"), true);
});

test("review-surfaces.COLLECTOR.9 swift test focus selectors", () => {
  assert.equal(commandLooksLikeTestCommand("swift test"), true);
  assert.equal(commandLooksLikeBroadTestCommand("swift test"), true);
  assert.equal(commandLooksLikeFocusedTestCommand("swift test --filter LoginTests"), true);
  // swift test list / --list-tests is inspection, not a run.
  assert.equal(commandLooksLikeTestCommand("swift test list"), false);
  assert.equal(commandLooksLikeTestCommand("swift test --list-tests"), false);
});

test("review-surfaces.COLLECTOR.9 dedicated xcodebuild classifier: test vs build vs informational", () => {
  // Test actions are test runs.
  assert.equal(
    commandLooksLikeBroadTestCommand(
      "xcodebuild test -project Example.xcodeproj -scheme Example -destination 'platform=iOS Simulator,name=iPhone 17 Pro'"
    ),
    true
  );
  assert.equal(commandLooksLikeBroadTestCommand("xcodebuild test-without-building -scheme App"), true);
  assert.equal(commandLooksLikeTestCommand("xcodebuild test -scheme App -testPlan UnitTests"), true);

  // Focused selectors narrow the run.
  assert.equal(
    commandLooksLikeFocusedTestCommand("xcodebuild test -scheme App -only-testing:AppTests/FooTests"),
    true
  );
  assert.equal(commandLooksLikeFocusedTestCommand("xcodebuild test -scheme App -skip-testing:AppTests/SlowTests"), true);

  // build / build-for-testing are validation, NEVER a test run.
  assert.equal(commandLooksLikeTestCommand("xcodebuild build-for-testing -scheme App"), false);
  assert.equal(commandLooksLikeBroadTestCommand("xcodebuild build-for-testing -scheme App"), false);
  assert.equal(commandLooksLikeLocalValidationCommand("xcodebuild build-for-testing -scheme App"), true);
  assert.equal(commandLooksLikeTestCommand("xcodebuild build -scheme App"), false);
  assert.equal(commandLooksLikeLocalValidationCommand("xcodebuild build -scheme App"), true);
  // No action defaults to build -> validation, not a test.
  assert.equal(commandLooksLikeTestCommand("xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17'"), false);
  assert.equal(commandLooksLikeLocalValidationCommand("xcodebuild -scheme App"), true);

  // Informational: prints and exits, never test evidence.
  assert.equal(commandLooksLikeTestCommand("xcodebuild -list"), false);
  assert.equal(commandLooksLikeTestCommand("xcodebuild -version"), false);
  assert.equal(commandLooksLikeTestCommand("xcodebuild -showBuildSettings -scheme App"), false);
  // A scheme literally named with an action word is not read as the action.
  assert.equal(commandLooksLikeTestCommand("xcodebuild -scheme build"), false);
});

test("review-surfaces.COLLECTOR.9 validated wrapper command rules classify repository wrappers (built-ins win)", () => {
  const rules = [
    { id: "ios-full", match: "exact" as const, command: "./scripts/check-ios.sh", classification: "broad_test" as const },
    { id: "ios-unit-only", match: "exact" as const, command: "./scripts/check-ios.sh --quick", classification: "focused_test" as const },
    { id: "ios-build-lint", match: "exact" as const, command: "./scripts/harness.sh ios-quick", classification: "validation" as const },
    { id: "full-handoff", match: "exact" as const, command: "./scripts/harness.sh full", classification: "broad_test" as const }
  ];
  assert.equal(commandLooksLikeBroadTestCommand("./scripts/check-ios.sh", rules), true);
  assert.equal(commandLooksLikeFocusedTestCommand("./scripts/check-ios.sh", rules), false);
  assert.equal(commandLooksLikeFocusedTestCommand("./scripts/check-ios.sh --quick", rules), true);
  assert.equal(commandLooksLikeBroadTestCommand("./scripts/check-ios.sh --quick", rules), false);
  assert.equal(commandLooksLikeTestCommand("./scripts/harness.sh ios-quick", rules), false);
  assert.equal(commandLooksLikeLocalValidationCommand("./scripts/harness.sh ios-quick", rules), true);
  assert.equal(commandLooksLikeBroadTestCommand("./scripts/harness.sh full", rules), true);

  // No rule -> a bare wrapper is unrecognized (no fabricated test evidence).
  assert.equal(commandLooksLikeTestCommand("./scripts/check-ios.sh"), false);
  assert.equal(commandLooksLikeLocalValidationCommand("./scripts/check-ios.sh"), false);

  // A rule can NEVER reclassify a direct built-in command (built-ins win).
  const badRule = [{ id: "evil", match: "prefix" as const, command: "xcodebuild build", classification: "broad_test" as const }];
  assert.equal(commandLooksLikeBroadTestCommand("xcodebuild build -scheme App", badRule), false);
});

test("review-surfaces.COLLECTOR.9 wrapper rule prefix matching is token-bounded and most-specific-wins", () => {
  const rules = [
    { id: "broad", match: "prefix" as const, command: "./run.sh", classification: "broad_test" as const },
    { id: "focused", match: "exact" as const, command: "./run.sh --one", classification: "focused_test" as const }
  ];
  // exact (more specific) wins over the broader prefix for the same command.
  assert.equal(commandLooksLikeFocusedTestCommand("./run.sh --one", rules), true);
  assert.equal(commandLooksLikeBroadTestCommand("./run.sh --all", rules), true);
  // a token boundary is required so ./run.shadow does not match the ./run.sh prefix.
  assert.equal(commandLooksLikeTestCommand("./run.shadow", rules), false);
});

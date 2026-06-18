import test from "node:test";
import assert from "node:assert/strict";
import { computeCrossReferenceSignals } from "../src/methodology/cross-reference";
import { CollectionResult } from "../src/collector/collect";
import { ConversationEvent } from "../src/conversation/events";
import { SemanticChangeFacts } from "../src/risks/semantic-diff";

function file(path: string, status = "M"): { path: string; status: string; source: string } {
  return { path, status, source: "working_tree" };
}

const HEAD_SHA = "headsha0000000000000000000000000000000000";

interface CollOpts {
  secretPaths?: string[];
  transcripts?: Array<{ command: string; status: string; exit_code: number; head_sha?: string }>;
  semanticFacts?: Partial<SemanticChangeFacts>;
  dependencyFacts?: Array<{ kind: string; package: string; detail: string; source_path: string }>;
  configFacts?: Array<{ kind: string; path: string; detail: string }>;
}

function collection(changed: ReturnType<typeof file>[], opts: CollOpts = {}): CollectionResult {
  return {
    changedFiles: changed,
    privacy: { secret_findings: (opts.secretPaths ?? []).map((path) => ({ path, kinds: ["aws_key"] })) },
    commandTranscripts: opts.transcripts ?? [],
    git: { repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: HEAD_SHA },
    semanticChangeFacts: { schema_changes: [], api_changes: [], test_weakening: [], ...(opts.semanticFacts ?? {}) },
    dependencyFacts: opts.dependencyFacts ?? [],
    configFacts: opts.configFacts ?? []
  } as unknown as CollectionResult;
}

// A NATURAL-LANGUAGE turn (kind "message"): the only kind the discussion check scans.
function talk(summary: string): ConversationEvent[] {
  return [{ id: "e0", actor: "user", kind: "message", summary, raw_index: 0 }];
}

// A TOOL turn whose summary carries a file path — must NOT count as discussion.
function toolTurn(summary: string): ConversationEvent[] {
  return [{ id: "t0", actor: "assistant", kind: "tool_call", summary, tool: "Edit", raw_index: 0 }];
}

type Findings = ReturnType<typeof computeCrossReferenceSignals>;

function signal(findings: Findings, kind: string): Findings[number] | undefined {
  return findings.find((finding) => finding.signal_kind === kind);
}

test("review-surfaces.METHODOLOGY.8 risky_no_security fires (advisory) for an auth change with no security discussion", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("refactored the upload flow")), "risky_no_security");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
  assert.equal(sig.severity, "medium");
});

test("review-surfaces.METHODOLOGY.8 risky_no_security is PROMOTED by a secret finding on a changed file", () => {
  const sig = signal(
    computeCrossReferenceSignals(collection([file("src/auth/login.ts")], { secretPaths: ["src/auth/login.ts"] }), talk("a refactor")),
    "risky_no_security"
  );
  assert.ok(sig);
  assert.equal(sig.advisory, false);
  assert.equal(sig.severity, "high");
});

test("review-surfaces.METHODOLOGY.8 risky_no_security fires + is PROMOTED by a security-relevant config fact", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file(".github/workflows/ci.yml")], { configFacts: [{ kind: "ci_new_secret_reference", path: ".github/workflows/ci.yml", detail: "x" }] }),
      talk("pipeline tweak")
    ),
    "risky_no_security"
  );
  assert.ok(sig, "a CI secret-reference fact raises a security signal even without an auth-named file");
  assert.equal(sig.advisory, false);
});

test("review-surfaces.METHODOLOGY.8 risky_no_security does NOT fire when security was discussed", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("reviewed the auth token handling for security"));
  assert.equal(signal(findings, "risky_no_security"), undefined);
});

test("review-surfaces.METHODOLOGY.8 a tool turn naming the changed file does NOT count as discussion (Codex P2)", () => {
  // The only turn is a tool call `Edit(src/auth/login.ts)` — its path contains "auth"
  // but it is not a security DISCUSSION, so the signal must still fire.
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), toolTurn("Edit(src/auth/login.ts)"));
  assert.ok(signal(findings, "risky_no_security"), "tool path text must not suppress the signal");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test fires when impl changed with no test change/run/talk", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("src/uploader.ts")]), talk("implemented the retry")), "impl_no_test");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
});

test("review-surfaces.METHODOLOGY.8 impl_no_test fires for a non-JS source file (Codex P2)", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("src/app.py")]), talk("implemented it")), "impl_no_test");
  assert.ok(sig, "Python/Go/Rust sources are implementation too");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test does NOT fire when a current-head test run passed (Codex P2)", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("src/uploader.ts")], { transcripts: [{ command: "pnpm run test", status: "passed", exit_code: 0, head_sha: HEAD_SHA }] }),
    talk("implemented the retry")
  );
  assert.equal(signal(findings, "impl_no_test"), undefined, "a current-head passing test run is coverage evidence");
});

test("review-surfaces.METHODOLOGY.8 a STALE (old-head) passing test run is NOT coverage (Codex P2)", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("src/uploader.ts")], { transcripts: [{ command: "pnpm run test", status: "passed", exit_code: 0, head_sha: "oldcommitsha000000000000000000000000000000" }] }),
    talk("implemented the retry")
  );
  assert.ok(signal(findings, "impl_no_test"), "a transcript from an older commit cannot have exercised this diff");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test does NOT fire when a test was added alongside the impl", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/uploader.ts"), file("tests/uploader.test.ts", "A")]), talk("implemented and tested"));
  assert.equal(signal(findings, "impl_no_test"), undefined);
});

test("review-surfaces.METHODOLOGY.8 impl_no_test is PROMOTED by a test-weakening fact, and a weakened test is not coverage (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("src/uploader.ts"), file("tests/uploader.test.ts", "M")], {
        semanticFacts: { test_weakening: [{ kind: "removed_assertion", path: "tests/uploader.test.ts", detail: "dropped 2 assertions" }] }
      }),
      talk("simplified the flow")
    ),
    "impl_no_test"
  );
  assert.ok(sig, "a weakened (modified) test must not count as coverage");
  assert.equal(sig.advisory, false, "the test-weakening fact promotes the signal");
});

test("review-surfaces.METHODOLOGY.8 api_no_compat fires from a SOURCE export change (not only .d.ts/schema) (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("src/api.ts")], { semanticFacts: { api_changes: [{ path: "src/api.ts", exports_added: ["newThing"], exports_removed: [], signatures_changed: [] }] } }),
      talk("added a helper")
    ),
    "api_no_compat"
  );
  assert.ok(sig, "an exported-symbol change in ordinary source emits the signal");
  assert.equal(sig.advisory, true, "a pure addition is compatible (advisory)");
});

test("review-surfaces.METHODOLOGY.8 api_no_compat is PROMOTED by a backward-incompatible export removal", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("src/api.ts")], { semanticFacts: { api_changes: [{ path: "src/api.ts", exports_added: [], exports_removed: ["oldThing"], signatures_changed: [] }] } }),
      talk("cleaned up")
    ),
    "api_no_compat"
  );
  assert.ok(sig);
  assert.equal(sig.advisory, false, "a removed export is backward-incompatible");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale fires for a config change with no rationale", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file(".github/workflows/ci.yml")]), talk("tweaked the pipeline")), "deps_no_rationale");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale fires for a SQL migration / config-fact class (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("db/migrations/001_init.sql")], { configFacts: [{ kind: "sql_destructive_statement", path: "db/migrations/001_init.sql", detail: "DROP TABLE" }] }),
      talk("schema work")
    ),
    "deps_no_rationale"
  );
  assert.ok(sig, "config-fact classes beyond the path allowlist still raise the signal");
  assert.equal(sig.advisory, false, "a risky config fact promotes it");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale is PROMOTED when a lockfile moves", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("package.json"), file("pnpm-lock.yaml")]), talk("build config")), "deps_no_rationale");
  assert.ok(sig);
  assert.equal(sig.advisory, false);
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale does NOT fire when the change was explained", () => {
  const findings = computeCrossReferenceSignals(collection([file("package.json")]), talk("bumped the dependency to fix a CVE, rationale in the PR"));
  assert.equal(signal(findings, "deps_no_rationale"), undefined);
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale STILL fires when the rationale is about an UNRELATED topic (#109)", () => {
  // The package IS named, but the only rationale word ("because") is far away and
  // explains the auth refactor, not the dependency — proximity is not met.
  const findings = computeCrossReferenceSignals(
    collection([file("package.json")], { dependencyFacts: [{ kind: "added", package: "left-pad", detail: "x", source_path: "package.json" }] }),
    talk(`Upgraded left-pad to v2 in package.json. ${"context ".repeat(40)} Separately I refactored the auth module because it was confusing.`)
  );
  assert.ok(signal(findings, "deps_no_rationale"), "a rationale stated about an unrelated topic must not suppress the dependency gap");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale does NOT fire when the rationale is NEAR the package (#109)", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("package.json")], { dependencyFacts: [{ kind: "added", package: "left-pad", detail: "x", source_path: "package.json" }] }),
    talk("upgraded left-pad because of a security patch")
  );
  assert.equal(signal(findings, "deps_no_rationale"), undefined, "a rationale next to the package name suppresses the gap");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale: proximity is bounded to the SAME sentence (Codex #110)", () => {
  // The package and the rationale word are close in characters but in DIFFERENT
  // sentences about different things — that must not count as a rationale for the bump.
  const findings = computeCrossReferenceSignals(
    collection([file("package.json")], { dependencyFacts: [{ kind: "added", package: "left-pad", detail: "x", source_path: "package.json" }] }),
    talk("Bumped left-pad. The auth refactor was needed because the old code was confusing.")
  );
  assert.ok(signal(findings, "deps_no_rationale"), "a rationale in a separate sentence must not suppress the dependency gap");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale: a config-noun rationale suppresses a CI/config change (Codex #110)", () => {
  // A workflow-only change is described by a config NOUN ("pipeline"), not its filename.
  const findings = computeCrossReferenceSignals(
    collection([file(".github/workflows/ci.yml")]),
    talk("reworked the pipeline because the deploy step was flaky")
  );
  assert.equal(signal(findings, "deps_no_rationale"), undefined, "rationale near a config noun suppresses the config gap");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale: a short package name still correlates (Codex #110)", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("package.json")], { dependencyFacts: [{ kind: "added", package: "ms", detail: "x", source_path: "package.json" }] }),
    talk("bumped ms because of a CVE")
  );
  assert.equal(signal(findings, "deps_no_rationale"), undefined, "a 2-char package name is recognized at a word boundary");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test: a file-correlated test mention clears only THAT file's gap (#109)", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/alpha.ts"), file("src/beta.ts")]), talk("I added tests for alpha"));
  const sig = signal(findings, "impl_no_test");
  assert.ok(sig, "beta has no test discussion, so its gap still fires");
  assert.match(sig.summary, /beta\.ts/, "the gap names the file with no test discussion");
  assert.doesNotMatch(sig.summary, /alpha\.ts/, "alpha's gap is cleared by the file-correlated test mention");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test: a GENERIC test mention does not clear an unmentioned file's gap (#109)", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/uploader.ts")]), talk("added comprehensive tests"));
  assert.ok(signal(findings, "impl_no_test"), "a generic 'added tests' with no file reference must not clear the per-file gap");
});

test("review-surfaces.METHODOLOGY.8 risky_no_security STILL fires when only the domain noun 'permission' is named (#109)", () => {
  // Naming "permissions" is not a security DISCUSSION; the dropped suppressor means it fires.
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("updated the permissions list")), "risky_no_security"));
});

test("review-surfaces.METHODOLOGY.8 impl_no_test STILL fires when 'unit' appears only inside an unrelated word (#109)", () => {
  // "united" must not count as a test discussion now that the 'unit' suppressor was dropped.
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/payments.ts")]), talk("we united the billing modules")), "impl_no_test"));
});

test("review-surfaces.METHODOLOGY.8 every cross-reference finding anchors to a changed file with a distinct id", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), []);
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.ok(finding.evidence.some((ref) => ref.kind === "file" && ref.validation_status === "valid"));
    assert.ok(finding.id.startsWith("XREF-"));
  }
});

test("review-surfaces.METHODOLOGY.8 a natural-language decision turn counts as discussion (Codex P2)", () => {
  // A normalized log can carry kind:"decision"; it is natural language and must be scanned.
  const events: ConversationEvent[] = [{ id: "d0", actor: "assistant", kind: "decision", summary: "Reviewed the auth flow for security before merging", raw_index: 0 }];
  assert.equal(signal(computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), events), "risky_no_security"), undefined);
});

test("review-surfaces.METHODOLOGY.8 api_no_compat fires for a DELETED schema surface even with no structural fact (Codex P2)", () => {
  // A pure delete yields no schema_changes fact; the removed surface must still trigger.
  const sig = signal(computeCrossReferenceSignals(collection([file("schemas/review_packet.schema.json", "D")]), talk("removed an old schema")), "api_no_compat");
  assert.ok(sig, "a removed public-contract surface triggers the signal on its own");
  assert.equal(sig.advisory, false, "a removed surface is inherently breaking");
});

test("review-surfaces.METHODOLOGY.8 api_no_compat fires when a public schema is renamed OUT of public scope (#103)", () => {
  // Renaming schemas/public.schema.json -> a non-schema path removes the public
  // contract from its old location; the NEW path is not a public surface, so only
  // the OLD path reveals it (the new path alone would miss the signal).
  const renamed = { path: "archive/old.txt", status: "R100", source: "diff", old_path: "schemas/public.schema.json" };
  const sig = signal(computeCrossReferenceSignals(collection([renamed]), talk("archived an old schema")), "api_no_compat");
  assert.ok(sig, "a public surface renamed out of scope triggers the signal via its old path");
  assert.equal(sig.advisory, false, "removing/renaming a public surface is inherently breaking");
  assert.match(sig.summary, /public\.schema\.json/, "the finding names the removed (old) public path");
  // The summary keeps the removed old path, but file evidence (stamped valid) must
  // anchor to a path that actually exists in the changed set — the rename
  // destination — not the deleted old_path (#103 round-4).
  assert.equal(sig.evidence[0].path, "archive/old.txt", "evidence anchors to the existing rename destination, not the deleted old path");
});

test("review-surfaces.METHODOLOGY.8 a rename INTO public scope does NOT fire api_no_compat (#103 round-5)", () => {
  // archive/old.txt -> schemas/public.schema.json ADDS a public surface; no public
  // contract left its old location, so this is not a removal. With old_path known
  // and non-public, the new-path fallback must NOT fire.
  const renamedIn = { path: "schemas/public.schema.json", status: "R100", source: "diff", old_path: "archive/old.txt" };
  const findings = computeCrossReferenceSignals(collection([renamedIn]), talk("promoted a file into the public schemas dir"));
  assert.equal(signal(findings, "api_no_compat"), undefined, "moving a file into public scope removes no contract");
});

test("review-surfaces.METHODOLOGY.8 a rename with a REDACTED source and public destination does NOT fire (#103 round-6)", () => {
  // When the rename source is ignored, collect strips old_path. The public NEW path
  // must NOT be used as a removed surface — that would false-fire a breaking removal
  // for what is a rename INTO public scope from a redacted source.
  const redactedRename = { path: "schemas/public.schema.json", status: "R100", source: "diff" }; // no old_path
  const findings = computeCrossReferenceSignals(collection([redactedRename]), talk("moved a generated file into schemas"));
  assert.equal(signal(findings, "api_no_compat"), undefined, "an absent old_path must not fall back to the new path's public-ness");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test still fires when only an UNRELATED test was edited (Codex P2)", () => {
  // The test file shares no name stem with the changed impl, so it is not coverage.
  const findings = computeCrossReferenceSignals(collection([file("src/payments.ts"), file("tests/unrelated.test.ts", "A")]), talk("changed payments"));
  assert.ok(signal(findings, "impl_no_test"), "an unrelated test edit must not be treated as coverage");
});

test("review-surfaces.METHODOLOGY.8 a correlated test (matching name stem) DOES count as coverage", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/payments.ts"), file("tests/payments.test.ts", "A")]), talk("changed payments"));
  assert.equal(signal(findings, "impl_no_test"), undefined, "a test whose stem matches the impl is coverage");
});

test("review-surfaces.METHODOLOGY.8 merely NAMING the auth domain does not count as security discussion (Codex P2)", () => {
  // "changed the auth flow" names the domain but proves no security reasoning.
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("changed the auth login flow")), "risky_no_security"));
});

test("review-surfaces.METHODOLOGY.8 input-validation paths are security-sensitive (Codex P2)", () => {
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/validators/user.ts")]), talk("tweaked the validator")), "risky_no_security"));
});

test("review-surfaces.METHODOLOGY.8 naming the package/lockfile is not a rationale (Codex P2)", () => {
  assert.ok(signal(computeCrossReferenceSignals(collection([file("package.json"), file("pnpm-lock.yaml")]), talk("updated package.json and the lockfile")), "deps_no_rationale"));
});

test("review-surfaces.METHODOLOGY.8 mentioning a product spec does not suppress impl_no_test (Codex P2)", () => {
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/uploader.ts")]), talk("implemented it per the product spec")), "impl_no_test"));
});

test("review-surfaces.METHODOLOGY.8 a colocated non-JS test file is NOT treated as implementation (Codex P2)", () => {
  // Only a Go test file changed — it must not read as an implementation change.
  assert.equal(signal(computeCrossReferenceSignals(collection([file("src/uploader_test.go")]), []), "impl_no_test"), undefined);
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale is PROMOTED by a non-security config fact (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file(".github/workflows/ci.yml")], { configFacts: [{ kind: "ci_unpinned_action", path: ".github/workflows/ci.yml", detail: "x" }] }),
      talk("pipeline change")
    ),
    "deps_no_rationale"
  );
  assert.ok(sig);
  assert.equal(sig.advisory, false, "any deterministic config fact is an independent check");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test fires for the UNTESTED file when only one of two impls is tested (Codex P2)", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("src/payments.ts"), file("src/refunds.ts"), file("tests/payments.test.ts", "A")]),
    talk("changed payments and refunds")
  );
  const sig = signal(findings, "impl_no_test");
  assert.ok(sig, "the untested refunds change still flags");
  assert.match(sig.summary, /refunds/, "the finding names the uncovered file");
  assert.doesNotMatch(sig.summary, /payments\.ts/, "the covered file is not listed");
});

test("review-surfaces.METHODOLOGY.8 an ordinary filename ending in 'test' is NOT a test file (Codex P2)", () => {
  // src/latest.ts and src/contest.py are implementation; impl_no_test must fire.
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/latest.ts")]), talk("worked on it")), "impl_no_test"));
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/contest.py")]), talk("worked on it")), "impl_no_test"));
});

test("review-surfaces.METHODOLOGY.8 full authentication/authorization paths are security-sensitive (Codex P2)", () => {
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/authentication/provider.ts")]), talk("provider work")), "risky_no_security"));
  assert.ok(signal(computeCrossReferenceSignals(collection([file("src/authorization/policy.ts")]), talk("policy work")), "risky_no_security"));
  // "author.ts" is NOT security-sensitive (no false positive).
  assert.equal(signal(computeCrossReferenceSignals(collection([file("src/author.ts")]), talk("byline")), "risky_no_security"), undefined);
});

test("review-surfaces.METHODOLOGY.8 non-Node manifests raise deps_no_rationale (Codex P2)", () => {
  for (const manifest of ["go.mod", "Cargo.toml", "requirements.txt", "pyproject.toml", "Gemfile", "pom.xml"]) {
    assert.ok(signal(computeCrossReferenceSignals(collection([file(manifest)]), talk("dependency work")), "deps_no_rationale"), `${manifest} should flag`);
  }
});

test("review-surfaces.METHODOLOGY.8 a multipart test name still correlates with its impl (Codex P2)", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/payments.ts"), file("tests/payments.integration.test.ts", "A")]), talk("changed payments"));
  assert.equal(signal(findings, "impl_no_test"), undefined, "payments.integration.test.ts covers payments.ts");
});

test("review-surfaces.METHODOLOGY.8 a secret finding in an ordinary file triggers risky_no_security (Codex P2)", () => {
  // src/client.ts has no auth/security token in its name, but a secret finding on it
  // is concrete security evidence and must raise (and promote) the signal.
  const sig = signal(computeCrossReferenceSignals(collection([file("src/client.ts")], { secretPaths: ["src/client.ts"] }), talk("client work")), "risky_no_security");
  assert.ok(sig, "a secret finding triggers the signal even without a security-named path");
  assert.equal(sig.advisory, false);
});

test("review-surfaces.METHODOLOGY.8 a FOCUSED test run does not globally suppress impl_no_test (Codex P2)", () => {
  // A focused run exercised only its target; an unrelated impl file is still uncovered.
  const findings = computeCrossReferenceSignals(
    collection([file("src/uploader.ts")], { transcripts: [{ command: "node --test dist/tests/foo.test.js", status: "passed", exit_code: 0, head_sha: HEAD_SHA }] }),
    talk("changed the uploader")
  );
  assert.ok(signal(findings, "impl_no_test"), "a focused test run is not global coverage");
});

test("review-surfaces.METHODOLOGY.8 fileStem does not strip 'test' from ordinary words like contest (Codex P2)", () => {
  // src/contest.ts is impl; an unrelated src/con.ts test must NOT be treated as its coverage.
  const findings = computeCrossReferenceSignals(collection([file("src/contest.ts"), file("tests/con.test.ts", "A")]), talk("worked on contest"));
  const sig = signal(findings, "impl_no_test");
  assert.ok(sig, "contest.ts is uncovered (con.test.ts is unrelated)");
  assert.match(sig.summary, /contest/);
});

test("review-surfaces.METHODOLOGY.8 a DELETED colocated test promotes impl_no_test (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(collection([file("src/uploader.go"), file("src/uploader_test.go", "D")]), talk("dropped the old flow")),
    "impl_no_test"
  );
  assert.ok(sig);
  assert.equal(sig.advisory, false, "a deleted colocated test is a concrete weakening");
});

test("review-surfaces.METHODOLOGY.8 an empty diff yields no cross-reference findings", () => {
  assert.deepEqual(computeCrossReferenceSignals(collection([]), talk("anything")), []);
});

test("review-surfaces.METHODOLOGY.8 with no conversation, the diff-based signals still fire (deterministic shell)", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), []);
  assert.ok(signal(findings, "risky_no_security"));
});

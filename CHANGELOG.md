# Changelog

All notable changes to `review-surfaces` are documented here. The project was
built agent-first — an MVP followed by several named uplifts — each landed
phase by phase behind the same local merge gate the tool itself enforces; the
full working contracts live in
[`docs/history/`](https://github.com/Shaance/review-surfaces/tree/main/docs/history)
(an absolute link because this changelog ships in the npm tarball, which does
not carry that directory).

## 0.2.0 — 2026-06-18 (first npm publish)

The package manifest already carries `0.2.0`, so the owner's single manual
step (`npm publish`) ships exactly this version — and `prepublishOnly` runs
the full local gate, so a publish physically cannot ship a red gate. The
package name `review-surfaces` was verified unclaimed on 2026-06-12.

- Range truth (`COLD_START.6-8`): the default base auto-resolves
  (origin/HEAD, origin/main, origin/master, main, master) and a base or head
  that cannot be resolved — or two refs with no common history — is a hard,
  actionable error instead of a silent working-tree fallback; working-tree
  files merge only into current-state reviews (literal `HEAD` or the
  checked-out branch) and every surface announces an absorbed uncommitted
  count; artifact-embedded pointers are sibling file names, so artifacts are
  byte-identical for any `--out` location and never contain `../` chains.
- Package first touch (`DISTRIBUTION.9-13`): `--version` works; the bin shim
  guards the Node >= 22 floor with one clear line on old runtimes; the README
  renders on the npm page (absolute image/doc links, `homepage`/`bugs`
  sidebar metadata, ~550 KB of screenshots no longer ship in the tarball);
  and a first run in a repo that has not gitignored the artifact dir prints
  one stderr hint.
- Change-map legibility at scale (`MAP_SCALE.1-6`): a schema-visible overview
  level that leads on every surface when the file-level map cannot render
  legibly (groups merged from model clusters, honest counts that sum to 100%
  of the diff, aggregated edges with weights); per-group zoom views in the
  cockpit (click an overview group) and `human_review.md` (collapsed details
  per group) with explicit cross-group stub ports; wrapped SVG layouts so no
  rendered map ever exceeds the width budget — a visual that cannot render
  legibly summarizes, never shrinks.
- Showcase and publish trim (`DISTRIBUTION.5-8`): committed example artifacts
  under `docs/example/` from a pinned spec-less run, README screenshots
  regenerated from real runs, a cockpit pointer at the end of every
  `review-surfaces all` run, this changelog, and the remaining internal
  proposals moved to `docs/history/`.
- Distribution trim and CI docs (`DISTRIBUTION.14-15`): the npm tarball no
  longer ships compiled tests — the `files` allowlist is narrowed from `dist`
  to `dist/src`, dropping ~1.6 MB / 87 `dist/tests` files that nothing at
  runtime needs; and the README documents CI consumption with a copy-pasteable
  GitHub Action `uses:` snippet (linking the worked example workflow) and an
  exit-code table so a CI author can wire the action and branch on exit codes.
- Agent-workflow / methodology audit (`METHODOLOGY.7-8`): the review reads the
  agent conversation transcript (auto-discovered for Claude Code; `--conversation`
  elsewhere) and surfaces an agent-workflow audit — considered alternatives,
  research/context, and four DETERMINISTIC cross-reference (D6) signals computed by
  cross-referencing the diff and the deterministic semantic/dependency/config facts
  against the conversation: `impl_no_test`, `risky_no_security`, `api_no_compat`,
  and `deps_no_rationale`. Each is advisory unless an independent deterministic fact
  corroborates it, in which case it is promoted to a blocking reviewer question; LLM
  leaves stay advisory until deterministic evidence validation accepts them. Rendered
  as an audit card on the HTML cockpit, with a `CONV-GAP` risk when the conversation
  reveals an untested changed file. A redaction/secret guard blocks any remote
  provider call when the diff or transcript carries high-risk secret material.
- Cross-language test-command recognition (`COLLECTOR.7`): the command classifier
  recognizes non-JS test runners — `go test`, `cargo test`, `pytest`, `mvn`/`gradle`,
  `dotnet test`, `rspec`, `phpunit`, `mix`/`swift`/`dart test` — with conservative
  broad-vs-focused classification (no-execution, exclusion, and info invocations
  screened out), so the "tests ran / tests weakened" and local-validation signals
  fire on non-Node repositories, not only on JS/TS.
- Zero-config transcript auditing for Codex (`METHODOLOGY.9`): when no
  `--conversation` is given, discovery now spans BOTH the Claude Code project store
  and the Codex rollout store (`~/.codex/sessions`). Because the Codex store is global
  (one store across every repo), a Codex session is eligible only when it references
  the reviewed range — never picked by recency alone — and the scan is bounded to the
  most-recent rollouts; a discovered session that references none of the reviewed range
  is a HARD warning pointing at `--conversation`, not a silent pick. Cursor keeps chat
  in a per-workspace SQLite database with no loose transcript file, so it stays
  explicit (`--conversation` with an exported chat; the `cursor` adapter parses it).
  `scripts/local-review.sh` forwards `--conversation`, `--conversation-format`, and
  `--no-conversation-discovery` verbatim. See
  [`docs/conversation-auditing.md`](https://github.com/Shaance/review-surfaces/blob/main/docs/conversation-auditing.md).
- Cold-start review-focus floor (`HUMAN_REVIEW.28`): a substantive diff no longer
  produces an empty review queue on a spec-less repo. When no detector produces a
  ranked item, a deterministic baseline queue ranks the changed files most worth
  reading — by churn, exported/public surface (read from the diff across TS/JS/Rust/
  Java/Go/Python), an implementation change with no connected test, and sensitive
  error/async/auth/network/persistence paths — and **fabricates no risk or blocker**
  (every item says "No risk rule produced a ranked finding, but this is worth reading
  because …"). Docs, generated/build output, and binary/lock artifacts are excluded.
  Verified live: `sindresorhus/ky` 0→2 and `spf13/cobra` 0→4 review-first items.

## 0.1.0 — 2026-05-30 through 2026-06-12 (unpublished development history; never on npm)

The MVP and four uplifts, condensed. Every phase shipped with ACID-named
tests against `features/review-surfaces.feature.yaml`, byte-deterministic
artifacts, and redaction before every render.

### MVP (PR #11)

- Local-first review packet compiler: `collect`, `intent`, `evaluate`,
  `diagrams`, `methodology`, `risks`, `dogfood`, `handoff`, `packet`, `all`,
  `validate` over `.review-surfaces/` artifacts; Acai-compatible spec
  ingestion; mock/agent-file/ai-sdk provider boundary; privacy ignore +
  secret redaction; deterministic evidence validation.

### Human review uplift (PRs #47–#52)

- The human review surface: verdict, ranked review queue with rollups and
  hunk excerpts, grounded narrative with verified/claimed trust markers,
  deterministic semantic change facts (schema/API/test-weakening via the TS
  AST), an interactive `review` walkthrough, and a GitHub draft-review
  export.

### Next-value uplift (PRs #53–#62)

- The PR surface: sticky summary comment with since-last-review deltas and a
  composite GitHub Action; ranking v2 with evidence tiers; lcov coverage
  evidence and `--budget` review plans; the seeded-regression eval harness
  (gates ranking changes in CI); dependency/blast-radius/config fear-class
  facts; the self-contained HTML cockpit; team policy YAML and
  provider-assisted intent candidates that never affect coverage.

### Visual value uplift (PRs #63–#69)

- The change-graph model and map: mermaid + clickable SVG emitters, the
  guided reading-order tour, coverage gutters, the header strip,
  architecture-drift facts, the review-rounds trend ledger, attributed
  dependency-chain trees, and the scripted local loop (`pnpm run
  local-review` / `local-gate`) that produces and gates every surface with
  zero CI.

### Open-source readiness uplift (PRs #70–#73)

- Cold-start correctness on a stranger's repository: package-root schema
  resolution, implementation roots derived from the target repo's own
  signals, trivia-free API signature comparison, spec-less mode
  (`spec_mode: none` suppresses every Acai-shaped output), LICENSE (MIT),
  CONTRIBUTING, the stranger-first README, and a packaging smoke test in the
  local gate.

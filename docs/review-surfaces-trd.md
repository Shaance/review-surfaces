# TRD: review-surfaces

**Status:** final bootstrap draft; human-cockpit update applied  
**Intended reader:** AI coding agent, maintainer, reviewer  
**Primary implementation target:** local-first open-source CLI  
**Core repository artifact:** `.review-surfaces/`  
**Spec ledger:** `features/review-surfaces.feature.yaml`  
**Last reviewed:** 2026-06-09

---

## 1. Executive summary

`review-surfaces` is a local-first reviewer brief for agent-generated code changes.

It does not try to replace the reviewer. It reduces reconstruction cost by answering, in order: what the author is trying to change, which independent decisions could change approval, what evidence supports those decisions, and what the reviewer should do next. Specs, diffs, tests, agent logs, and diagnostics remain evidence underneath that brief; they are not the brief itself.

The primary surface is adaptive. A 100-file mechanical migration may need one approval decision, while a 12-file cross-boundary change may need six. The product must therefore scale to independent decision roots rather than enforce universal word, line, or item caps. Numeric bounds are allowed for schema safety, abuse resistance, and evaluation, but must not silently hide an approval-changing decision.

The verdict is about the change, not the analysis pipeline. Optional enrichment being unavailable, invalid, privacy-blocked, or baseline-limited may reduce available context but cannot manufacture an author-clarification verdict or merge blocker. Missing evidence reduces confidence; only a concrete approval decision, independently detected policy violation, or merge blocker changes the review state.

The central output is a directory:

```text
.review-surfaces/
  manifest.json
  inputs/
  intent.yaml
  evaluation.yaml
  architecture.md
  methodology.yaml
  risks.yaml
  dogfood.yaml
  agent_handoff.md
  diagrams/
  review_packet.md
  review_packet.json
  human_review.md
  human_review.json
  review_queue.md
  suggested_comments.md
  trust_audit.md
  test_plan.md
```

The first product surface is the local file system, with `human_review.md` as the default reviewer entrypoint and `review_packet.json` as the default machine evidence contract. GitHub comments, GitLab comments, CI checks, dashboards, Acai sync, and SARIF exports are renderers over the same local artifacts.

For this project itself, Acai-style `feature.yaml` is not merely an integration target. It is the source-of-truth requirements ledger for the repository. The repo should contain `features/review-surfaces.feature.yaml`, code/tests should preserve stable ACIDs where useful, and every milestone should run the strongest available subset of `review-surfaces` against the `review-surfaces` repo itself.

The local `coffee-agents` setup is only bootstrap context: useful local conventions, existing `AGENTS.md` material, scripts, or agent skills may be copied or adapted, but the open-source product must not depend on private paths or local-only tooling.

---

## 2. Product thesis

Agent-generated PRs/MRs are difficult to review because the human often has to reconstruct:

- what the agent thought the task was;
- which specs, tickets, docs, and conversations were relevant;
- what files changed and why;
- whether requirements were satisfied, partially satisfied, skipped, or exceeded;
- what was tested versus merely claimed;
- what architecture changed;
- what assumptions were not challenged;
- where manual review attention should go first.

Most review tools focus on diff comments or generic AI summaries. This project should instead create a human-first review surface that is compact, source-backed, and useful to both reviewers and future agents.

The product should be closer to a compiler than a chatbot:

```text
inputs + deterministic collection + bounded LLM steps + validation = review packet
```

The LLM may interpret, summarize, cluster, and classify. The deterministic shell must collect inputs, validate schemas, verify evidence paths, validate line ranges, enforce privacy rules, and write stable artifacts.

---

## 3. Non-negotiable principles

### 3.1 Local first

The CLI must be useful before any hosted service, CI integration, or PR comment exists.

The earliest useful command should be runnable from a repository checkout and should write files under `.review-surfaces/`.

### 3.2 Evidence before confidence

Every substantive generated claim must have evidence or be explicitly marked as unknown, assumption, hypothesis, or missing evidence.

Bad output:

```text
The auth flow is fully tested.
```

Acceptable output:

```yaml
status: partial
claim: The auth flow has unit test evidence but no e2e evidence.
evidence:
  - kind: test
    path: tests/auth.test.ts
    test_name: redirects after login
missing_evidence:
  - e2e test for invalid session refresh
```

### 3.3 Deterministic shell, probabilistic leaves

Code controls:

- input discovery;
- git diff collection;
- spec parsing;
- test-output parsing;
- schema validation;
- evidence validation;
- artifact writing;
- exit codes;
- caching;
- privacy exclusions.

LLMs may fill bounded schemas for:

- intent synthesis;
- requirement-to-diff reasoning;
- subsystem labeling;
- methodology audit;
- risk narrative;
- review focus summarization.

LLM output is never accepted as valid until schema and evidence validation pass.

### 3.4 Review-sized output

The packet should not become a long AI essay. It should produce tables, short cards, diagrams, and focused review queues.

The reviewer should be able to answer quickly:

1. What is this change trying to accomplish?
2. What could change my approval decision?
3. What evidence supports or weakens each decision?
4. What should I ask, inspect, or run next?

Repository requirement coverage, change maps, reading tours, round ledgers, provider status, and exhaustive queues are supporting artifacts. They appear in the primary surface only when they directly answer one of those questions.

### 3.5 Dogfood-first development

The project must be designed so that the tool helps build itself.

Every milestone should run the strongest available subset of `review-surfaces` against the current repository and record either:

- a self-review packet; or
- a clear reason why the packet could not yet be generated.

Dogfood findings are product findings. They should become code changes, tests, schema changes, spec updates, skill updates, or explicit deferrals.

---

## 4. External references and assumptions

This TRD assumes the current Acai conventions checked on 2026-05-27:

- Acai feature specs live under `features/` and are named `<feature-name>.feature.yaml`.
- A feature spec has a `feature` top-level property and may have `components` and `constraints`.
- Requirements may be string values or objects containing a `requirement` property and optional metadata such as `note`.
- ACIDs have the shape `<feature-name>.<GROUP_KEY>.<ID>`.
- The Acai CLI can install an agent skill to `.agents/skills/acai/SKILL.md`.

The repo should not require hosted Acai access for the MVP. It should parse local Acai-compatible files and preserve ACIDs locally. Hosted API/dashboard sync can be added later.

---

## 5. User workflows

### 5.1 Human reviewer workflow

The human reviewer wants to review a branch without rereading a long conversation or reverse-engineering every changed file.

Expected flow:

```bash
review-surfaces run -- pnpm run test

review-surfaces all \
  --base origin/main \
  --head HEAD \
  --spec features/review-surfaces.feature.yaml \
  --out .review-surfaces
```

Then inspect:

```text
.review-surfaces/review_packet.md
.review-surfaces/evaluation.yaml
.review-surfaces/risks.yaml
.review-surfaces/architecture.md
```

### 5.2 Implementation agent workflow

The coding agent should use the packet as both pre-work context and post-work review.

Before editing:

1. Read `features/review-surfaces.feature.yaml`.
2. Read `AGENTS.md`.
3. Read `.agents/skills/review-surfaces/SKILL.md` if available.
4. Read `.review-surfaces/agent_handoff.md` and `.review-surfaces/review_packet.md` if present.
5. Identify the current milestone and relevant ACIDs.

After editing:

1. Run tests.
2. Run the strongest available `review-surfaces` subset.
3. Inspect the generated packet and risks.
4. Fix high-confidence in-scope findings.
5. Record deferrals and handoff notes.

### 5.3 Subagent workflow

A subagent may be assigned one bounded step, such as:

- build intent from files;
- evaluate implementation against intent;
- generate architecture diagrams;
- audit methodology from logs;
- compute risks and test gaps.

Each subagent should read and write structured files rather than relying on chat context.

### 5.4 Skill-assisted workflow

The repo carries three reusable local skills:

- `.agents/skills/review-surfaces-usage/SKILL.md` for running review-surfaces in any repository without relying on hosted renderers (`review-surfaces.BOOTSTRAP.6`);
- `.agents/skills/review-surfaces-dogfood-loop/SKILL.md` for improving this repository through generated packets, feedback files, and explicit deferrals (`review-surfaces.DOGFOOD.8`);
- `.agents/skills/composed-review-loop/SKILL.md` for combining packet evidence, command transcripts, dogfood findings, PR feedback, and a full-diff review into one readiness decision (`review-surfaces.DOGFOOD.9`).

These skills are workflow aids over the same local `.review-surfaces/` artifacts. They must not introduce private path dependencies or make provider calls required for the core packet.

### 5.5 Later PR/MR workflow

Later, CI can run the same local pipeline and post a sticky comment or upload artifacts. This must not redefine the core artifact shapes.

---

## 6. Core artifact: the review packet

### 6.1 Artifact directory

```text
.review-surfaces/
  manifest.json
  inputs/
    diff.patch
    changed_files.json
    commits.json
    commands.json
    specs.index.json
    docs.index.json
    tests.index.json
    conversation.normalized.jsonl
  intent.yaml
  evaluation.yaml
  architecture.md
  methodology.yaml
  risks.yaml
  dogfood.yaml
  agent_handoff.md
  diagrams/
    high-level.mmd
    subsystem-map.mmd
    flow.mmd
  review_packet.md
  review_packet.json
  pr_review_surface.json
  feedback/
    *.yaml
```

### 6.2 File responsibilities

| File | Purpose |
|---|---|
| `manifest.json` | Run metadata: tool version, git refs, run mode, input hashes, config. |
| `inputs/*` | Deterministic indexes and normalized raw material. |
| `inputs/commands.json` | Bounded command transcript summaries with exit code, duration, hashes, and capped excerpts. |
| `intent.yaml` | What the tool believes the task requires, with sources and unknowns. |
| `evaluation.yaml` | Requirement-by-requirement implementation coverage. |
| `architecture.md` | Architecture decomposition, diagrams, subsystem cards. |
| `methodology.yaml` | Process audit from conversation/tool logs. |
| `risks.yaml` | Risk register, test evidence, missing checks, review focus. |
| `dogfood.yaml` | Findings from using the product on itself. |
| `agent_handoff.md` | Compact briefing for the next agent. |
| `review_packet.md` | Human-readable packet. |
| `review_packet.json` | Machine-readable packet, validated by JSON Schema. |
| `pr_review_surface.json` | PR-scoped deterministic sidecar: changed files, affected requirements, coverage deltas, PR risks, and supporting diagram metadata. |
| `feedback/*.yaml` | Optional human or agent feedback on packet usefulness. |

### 6.3 Review packet sections

`review_packet.md` should use stable headings:

```markdown
# Review Packet

## 1. Review focus
## 2. Intent
## 3. Requirement coverage
## 4. Architecture surfaces
## 5. Methodology audit
## 6. Test evidence and gaps
## 7. Risks
## 8. Dogfood findings
## 9. Open questions
## 10. Evidence appendix
```

The top of the packet should be compact. Details should be in appendices or linked structured files.

---

## 7. High-level architecture

```text
Specs / docs / plans / AGENTS.md / skills
Agent conversation logs / tool logs
Git repo / base-head diff / changed files
Tests / coverage / CI output
Human feedback files
        |
        v
Collector + Normalizer
        |
        +--> Repo & Diff Indexer
        +--> Acai Spec Indexer
        +--> Test Evidence Ingestor
        +--> Conversation Log Normalizer
        +--> Privacy / Secret Guard
        |
        v
Intent Builder
        |
        v
Implementation Evaluator
        |
        +--> Diagram Generator
        +--> Methodology Auditor
        +--> Risk Analyzer
        +--> Dogfood Loop Manager
        |
        v
Packet Renderer
        |
        +--> .review-surfaces/review_packet.md
        +--> .review-surfaces/review_packet.json
        +--> .review-surfaces/agent_handoff.md
        +--> later: PR/MR comments, SARIF, Acai sync
```

### 7.1 Component boundaries

| Component | Deterministic responsibilities | LLM-assisted responsibilities |
|---|---|---|
| Collector | find files, copy/index inputs, hash content, apply ignores | none or minimal labeling |
| Repo indexer | classify changed files, parse imports where supported, map tests | suggest semantic subsystem names |
| Acai indexer | parse `*.feature.yaml`, compute ACIDs | none |
| Intent builder | validate output schema and evidence refs | synthesize intent from specs/docs/logs |
| Evaluator | enumerate requirements, verify paths/tests | classify coverage and overreach |
| Diagram generator | emit valid files, verify referenced paths | label clusters, summarize responsibilities |
| Methodology auditor | normalize logs, verify event IDs | summarize considered options and missed challenges |
| Risk analyzer | apply scoring rules, merge missing evidence | explain review risks and suggested checks |
| Dogfood manager | compare current/previous packet, ingest feedback | classify usefulness/friction |
| Renderer | stable markdown/json output | compact narrative summaries |

---

## 8. Input model

### 8.1 Repository inputs

Required when available:

- base ref;
- head ref;
- base SHA;
- head SHA;
- diff patch;
- changed file list;
- commit metadata;
- package metadata;
- language/framework detection.

### 8.2 Spec and documentation inputs

Primary sources:

- `features/**/*.feature.yaml`;
- `AGENTS.md`;
- `.agents/skills/**/SKILL.md`;
- `README.md`;
- `docs/**`;
- `plans/**`;
- issue/PR templates if available.

Acai-specific requirement:

- preserve ACIDs such as `review-surfaces.INTENT.2` in intent, evaluation, risks, tests, and rendered packet output.

### 8.3 Conversation and tool logs

Support a normalized JSONL format first:

```json
{"id":"evt_0001","ts":"2026-05-27T12:00:00Z","actor":"user","kind":"message","summary":"Asked for review packet compiler"}
{"id":"evt_0002","ts":"2026-05-27T12:01:00Z","actor":"agent","kind":"tool_call","tool":"search","summary":"Researched Acai feature.yaml"}
{"id":"evt_0003","ts":"2026-05-27T12:05:00Z","actor":"agent","kind":"decision","summary":"Use local-first CLI before GitHub bot"}
```

Missing logs must not be fatal. They should produce methodology findings and unknowns.

The conversation-audit uplift (docs/history/CONVERSATION_AUDIT_UPLIFT_GOAL.md) makes the
normalized JSONL above the *output* of a pluggable raw-transcript adapter registry
(`src/conversation/`). A `ConversationAdapter` `detect()`/`normalize()` pair converts a
RAW harness transcript — Claude Code session JSONL, Codex CLI rollout items, OR Cursor
chat/composer exports, including `tool_use`/`tool_result`/`function_call` evidence — into
the shared `ConversationEvent` stream, auto-detecting by content shape with a
`--conversation-format claude-code|codex|cursor|normalized` override. The three
pre-normalized forms (jsonl/yaml/plain text) stay supported via the `normalized` adapter.
Adapters are tolerant of unknown fields and never fatal; an unmatched/rotted shape
degrades to no-match (`conversation_log_missing`), never a wrong-adapter mis-normalization.
Every extracted field is redacted at normalization, and the persisted normalized log is
redact-before-bound + hash-on-blocked (PRIVACY.7).

### 8.4 Test and execution evidence

Support these incrementally:

- command transcripts;
- JUnit XML;
- coverage summary;
- package-manager scripts;
- test file ACID references;
- CI artifacts later.

The first local transcript capture helper is:

```bash
review-surfaces run -- pnpm run test
```

It writes `.review-surfaces/commands/<id>.json` with bounded, redacted excerpts and hashes. It must not preserve unbounded raw command output. When `--out <dir>` is supplied and `--command-transcripts` is not, `run` writes to `<dir>/commands` and packet generation reads transcripts from that same output directory. Default transcript IDs are deterministic by command so repeated validation loops overwrite stale evidence unless the caller supplies an explicit `--id`.

Example:

```json
{
  "schema_version": "review-surfaces.command_transcripts.v1",
  "commands": [
    {
      "id": "CMD-20260528-TEST",
      "command": "pnpm run test",
      "status": "passed",
      "exit_code": 0,
      "duration_ms": 1200,
      "started_at": "2026-05-28T12:00:00.000Z",
      "completed_at": "2026-05-28T12:00:01.200Z",
      "stdout_excerpt": "34 tests passed",
      "stdout_hash": "sha256...",
      "truncated": false
    }
  ]
}
```

---

## 9. Core data contracts

### 9.1 EvidenceRef

All modules should use a shared evidence shape.

```yaml
kind: file|diff|test|ci|doc|spec|conversation|command|feedback|agent_instruction|url|unknown
path: src/intent/buildIntent.ts
line_start: 10
line_end: 80
sha: abc123
acai_id: review-surfaces.INTENT.2
event_id: evt_000123
test_name: parses Acai object requirements
command: pnpm test
confidence: high|medium|low|unknown
validation_status: valid|invalid|not_checked|unknown
note: Short explanation of what this proves
```

Rules:

- file paths must exist unless the evidence kind is historical, deleted, URL, or unknown;
- line ranges must be valid for the referenced file when possible;
- test names must come from parsed test output or be marked unverified;
- conversation event IDs must exist in `conversation.normalized.jsonl`;
- LLM-emitted evidence must be validated before rendering as fact.

### 9.2 Intent requirement

```yaml
id: REQ-001
acai_id: review-surfaces.INTENT.1
title: Generate intent from source files
requirement: The tool must generate intent.yaml from specs, docs, and logs.
source_refs:
  - kind: spec
    path: features/review-surfaces.feature.yaml
    acai_id: review-surfaces.INTENT.1
confidence: high
assumptions: []
open_questions: []
```

### 9.3 Requirement result

```yaml
requirement_id: REQ-001
acai_id: review-surfaces.INTENT.1
status: satisfied|partial|missing|unknown|overreach|invalid_evidence
summary: Intent generation is implemented for Acai specs and docs, but not conversation logs.
evidence:
  - kind: file
    path: src/intent/buildIntent.ts
  - kind: test
    path: tests/intent.test.ts
missing_evidence:
  - kind: conversation
    note: No fixture covers normalized conversation logs yet.
review_focus: Verify sparse-source behavior and unsupported requirement handling.
```

### 9.4 Risk item

```yaml
id: RISK-001
category: correctness|security|privacy|maintainability|architecture|testing|workflow|release
severity: low|medium|high|critical
likelihood: low|medium|high|unknown
detectability: easy|moderate|hard|unknown
summary: Evaluator may overstate requirement coverage when tests are only named similarly.
evidence:
  - kind: file
    path: src/evaluation/mapTests.ts
suggested_checks:
  - Add fixture where unrelated tests mention similar words but no ACID.
manual_review: true
```

### 9.5 Dogfood finding

```yaml
id: DOG-001
category: usability|review_value|evidence_quality|agent_workflow|schema|diagram_quality|test_gap|performance
severity: low|medium|high
packet_section: Requirement coverage
finding: The packet listed satisfied requirements without showing the exact test evidence.
impact: Reviewer still had to inspect tests manually.
remediation:
  type: schema|code|test|doc|spec|skill|defer
  description: Split direct and indirect test evidence in evaluation.yaml.
```

---

## 10. Module requirements

### 10.1 Collector

The collector must:

- resolve base/head refs;
- collect diff and changed files;
- write `manifest.json`;
- hash input files;
- discover Acai specs under `features/**/*.feature.yaml`;
- discover docs, plans, README, AGENTS, and skills;
- ingest bounded command transcripts and test outputs when supplied;
- normalize supported conversation logs;
- respect `.review-surfacesignore`;
- avoid copying raw secrets into artifacts.

### 10.2 Repo & Diff Indexer

The indexer must:

- classify changed files as source, test, docs, config, generated, lockfile, unknown;
- detect likely language and package ecosystem;
- map source files to nearby tests using filename and directory heuristics;
- parse imports for TypeScript/JavaScript first;
- later support Python, Go, Rust, and other ecosystems;
- expose deterministic clusters that the LLM may label but not invent.

### 10.3 Acai Spec Indexer

The Acai indexer must:

- parse `features/**/*.feature.yaml`;
- support string and object requirement notation;
- preserve requirement notes, deprecation, skip, and replacement metadata;
- compute ACIDs as `<feature-name>.<GROUP_KEY>.<ID>`;
- write a stable `specs.index.json` or `acai.index.json`;
- not require hosted Acai access.

### 10.4 Intent Builder

The intent builder must:

- generate `intent.yaml`;
- include summary, requirements, constraints, non-goals, assumptions, open questions;
- cite sources for every requirement;
- preserve ACIDs;
- mark unsupported claims as assumptions or unknowns;
- avoid inventing product goals from sparse context;
- support a mock provider for deterministic tests.

### 10.5 Implementation Evaluator

The evaluator must:

- produce one result per intent requirement;
- map requirements to source, diff, docs, tests, commands, and log evidence;
- detect missing implementation evidence;
- detect missing test evidence;
- distinguish exact ACID-backed test evidence from broad test-path evidence so similarly named tests do not overstate coverage;
- detect overreach: changed files or behavior that do not map to stated intent;
- detect invalid evidence references;
- preserve Acai coverage metadata.

### 10.6 Diagram Generator

The diagram generator must:

- emit Mermaid first;
- write diagrams under `.review-surfaces/diagrams/`;
- generate high-level, subsystem, and flow diagrams;
- include per-subsystem cards in `architecture.md`;
- cite file evidence for subsystem membership;
- validate that referenced files exist;
- validate generated Mermaid artifact shape and surface invalid or noisy diagrams in packet artifacts;
- use deterministic clustering first and LLM labels second.

### 10.7 Methodology Auditor

The methodology auditor must:

- read normalized conversation/tool logs;
- summarize considered options, research, decisions, skipped work, unchallenged assumptions, and quality flags;
- separate claimed tests from verified tests;
- mark missing logs as a useful finding rather than fatal failure;
- feed findings into risk analysis and review focus.

### 10.8 Risk Analyzer

The risk analyzer must:

- generate `risks.yaml`;
- combine intent, evaluation, architecture, methodology, and tests;
- classify risks by category, severity, likelihood, and detectability;
- list what was tested and how;
- list missing manual and automatic checks;
- produce a compact human review focus.

### 10.9 Dogfood Loop Manager

The dogfood manager must:

- run in `--dogfood` mode;
- record current milestone;
- compare current packet with previous packet when available;
- ingest `.review-surfaces/feedback/*.yaml`;
- produce `dogfood.yaml`;
- classify product friction separately from implementation bugs;
- propose remediation tasks or spec updates.

### 10.10 Agent Handoff Renderer

The handoff renderer must generate `.review-surfaces/agent_handoff.md` with:

- current milestone;
- relevant ACIDs;
- last run summary;
- commands that succeeded/failed;
- open risks;
- in-scope next tasks;
- deferrals;
- paths to packet artifacts.

### 10.11 Packet Renderer

The packet renderer must:

- write `review_packet.md` and `review_packet.json`;
- keep stable headings and anchors;
- support compact and full modes;
- include an evidence appendix;
- validate JSON output against `schemas/review_packet.schema.json`;
- avoid claiming that optional sections exist when they were not produced.

### 10.12 Later provider integrations

Later renderers may include:

- GitHub sticky comment;
- GitLab MR note;
- Gerrit comment;
- SARIF;
- Acai CLI/API sync;
- dashboard export.

These must consume local artifacts rather than bypassing the core pipeline.

---

## 11. CLI design

### 11.1 Command shape

Initial CLI name: `review-surfaces`.

Expected commands:

```bash
review-surfaces init
review-surfaces bootstrap
review-surfaces collect
review-surfaces intent
review-surfaces evaluate
review-surfaces diagrams
review-surfaces methodology
review-surfaces risks
review-surfaces dogfood
review-surfaces handoff
review-surfaces packet
review-surfaces all
review-surfaces validate
review-surfaces run -- pnpm run test
review-surfaces comment   # later
```

### 11.2 MVP flags

```bash
review-surfaces all \
  --base origin/main \
  --head HEAD \
  --spec features/review-surfaces.feature.yaml \
  --conversation path/to/conversation.jsonl \
  --test-output reports/junit.xml \
  --out .review-surfaces \
  --dogfood \
  --llm mock
```

Rules:

- all commands must have help output;
- all commands must accept `--out`;
- all commands must avoid modifying repo files except `init`/`bootstrap` or explicitly configured writes;
- commands should be composable by reading previous artifacts from `--out`;
- early commands may emit skeleton unknowns when dependencies are missing.

### 11.3 Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success. |
| 1 | Tool/runtime error. |
| 2 | Invalid CLI usage or config. |
| 3 | Schema validation failed. |
| 4 | Evidence validation failed. |
| 5 | Privacy/secret guard blocked remote processing. |
| 10 | Optional quality gate failed. |

For early dogfooding, missing unimplemented modules should usually produce partial artifacts and warnings, not hard failures.

### 11.4 Config file

Default path:

```text
review-surfaces.config.yaml
```

Example:

```yaml
schema_version: review-surfaces.config.v1
output_dir: .review-surfaces
specs:
  - features/**/*.feature.yaml
docs:
  - README.md
  - docs/**/*.md
  - AGENTS.md
  - .agents/skills/**/SKILL.md
contract_surfaces:
  # Package exports/entries and declaration files are automatic. Add documented
  # extension APIs or other supported public modules with * / ** globs.
  paths: []
privacy:
  ignore_file: .review-surfacesignore
  redact_secrets: true
llm:
  provider: mock
  model: null
  require_json_schema: true
diagrams:
  format: mermaid
render:
  mode: compact
  include_evidence_appendix: true
dogfood:
  enabled: true
  milestone: M0
```

---

## 12. Repository bootstrap structure

Recommended initial repo layout:

```text
review-surfaces/
  AGENTS.md
  README.md
  package.json
  pnpm-lock.yaml
  review-surfaces.config.yaml
  features/
    review-surfaces.feature.yaml
  schemas/
    review_packet.schema.json
  docs/
    review-surfaces-trd.md
    dogfooding.md
  .agents/
    skills/
      review-surfaces/
        SKILL.md
  src/
    cli/
    core/
    collector/
    indexer/
    acai/
    intent/
    evaluation/
    diagrams/
    methodology/
    risks/
    dogfood/
    render/
    llm/
  tests/
    fixtures/
      minimal-repo/
      sparse-spec/
      overreach/
      missing-tests/
```

Recommended language for MVP: TypeScript.

Reasons:

- strong fit for CLI and GitHub Action later;
- good JSON/YAML/schema ecosystem;
- easy `pnpm` distribution;
- reasonable agent ergonomics;
- can call out to other languages later.

---

## 13. Testing strategy

### 13.1 Unit tests

Required early:

- Acai feature spec parser;
- ACID generation;
- config loading;
- `.review-surfacesignore` matching;
- evidence validation;
- review packet schema validation;
- risk scoring;
- renderer stable headings.

### 13.2 Fixture tests

Create fixture repositories for:

- minimal repo with one spec and one source file;
- sparse docs with open questions;
- conflicting docs;
- requirement implemented without tests;
- tests present but not linked to requirement;
- unrelated changed file overreach;
- missing conversation logs;
- invalid evidence line range;
- generated/lockfile-heavy diff.

### 13.3 End-to-end tests

Run the CLI against fixtures:

```bash
review-surfaces all --base main --head feature --spec features/example.feature.yaml --out tmp/out --llm mock
review-surfaces validate tmp/out/review_packet.json
```

### 13.4 Dogfood tests

The repository should maintain a self-run fixture or golden snapshot for at least one milestone. This should not freeze natural language too aggressively; assert structure, evidence validity, and key findings instead.

### 13.5 LLM regression tests

Use recorded mock outputs for CI. Real LLM calls should be opt-in for evaluation runs, not required for normal tests.

---

## 14. Security and privacy

### 14.1 Raw logs

Raw conversation logs may contain secrets, customer data, private prompts, or credentials. By default:

- do not copy raw logs into public artifacts;
- store normalized summaries and event IDs;
- hash sensitive excerpts;
- require explicit config to include raw excerpts.

### 14.2 Secrets

Before any remote LLM call:

- run secret detection on candidate payloads;
- redact high-confidence secrets;
- block remote processing when redaction is uncertain;
- allow local/mock provider paths for offline use.

### 14.3 Trust boundary

The tool should never infer private context that is not present in files/logs. Missing context is an open question.

### 14.4 Supply chain

For MVP:

- keep dependencies small;
- pin package manager lockfile;
- avoid executing arbitrary repo scripts unless explicitly configured;
- document which commands are run by the tool.

---

## 15. Dogfooding design

Dogfooding is part of the architecture, not an afterthought.

### 15.1 Milestone loop

At each milestone:

```text
Read feature spec + handoff
        |
        v
Implement smallest coherent slice
        |
        v
Run tests + strongest available review-surfaces command
        |
        v
Inspect packet / evaluation / risks / dogfood
        |
        v
Fix or defer findings
        |
        v
Update handoff and, if needed, feature spec
```

### 15.2 What counts as successful dogfood

A successful dogfood run does not need to say the project is complete. It must produce useful feedback.

Useful feedback includes:

- a requirement was misunderstood;
- evidence was missing;
- output was too verbose;
- packet was hard to use;
- commands were unclear;
- diagram was misleading;
- test gaps were not specific enough;
- agent handoff omitted key context.

### 15.3 Feedback ingestion

The tool should read human feedback files:

```yaml
schema_version: review-surfaces.feedback.v1
author: human
created_at: 2026-05-27T00:00:00Z
packet_path: .review-surfaces/review_packet.md
findings:
  - id: FB-001
    category: review_value
    severity: medium
    affected_section: Requirement coverage
    finding: The packet says a requirement is satisfied but does not show exact tests.
    desired_change: Split direct and indirect test evidence.
```

### 15.4 Dogfood output contract

`dogfood.yaml` must include:

- milestone;
- command run;
- whether the tool helped the agent;
- whether it helped the human reviewer;
- findings;
- remediation tasks;
- deferrals;
- previous packet comparison when available.

---

## 16. Milestone plan

### M0: Bootstrap, schemas, and CLI skeleton

Goal: create a repo that agents can start from without hidden chat context.

Deliver:

- `features/review-surfaces.feature.yaml`;
- `AGENTS.md`;
- `.agents/skills/review-surfaces/SKILL.md`;
- `docs/review-surfaces-trd.md`;
- `docs/dogfooding.md`;
- `schemas/review_packet.schema.json`;
- TypeScript package scaffold;
- CLI with help output;
- config loader;
- `validate` command for schema/config basics;
- mock LLM provider interface;
- first manual or skeleton `.review-surfaces/` packet.

Acceptance:

- `pnpm test` works;
- `review-surfaces --help` works;
- `review-surfaces validate` can validate sample packet JSON;
- first dogfood feedback file exists if the full pipeline cannot run yet.

### M1: Collector, Acai parser, repo indexer

Goal: deterministic input collection.

Deliver:

- `collect` command;
- git diff collection;
- changed files index;
- Acai feature parser with ACID generation;
- docs/AGENTS/skills index;
- `.review-surfacesignore` support;
- privacy guard skeleton;
- `manifest.json` and `inputs/*` artifacts.

Dogfood:

- run collector against this repo;
- verify `review-surfaces.*` ACIDs are preserved;
- record missing inputs and usability friction.

### M2: Intent builder

Goal: generate source-backed task intent.

Deliver:

- `intent` command;
- `intent.yaml` contract;
- source-backed requirements;
- assumptions/open questions;
- mock LLM output tests;
- sparse/conflicting source fixtures.

Dogfood:

- generate intent for `review-surfaces` itself;
- compare against the feature spec;
- update spec or prompt if intent is wrong.

### M3: Evaluator and risks

Goal: compare implementation against intent and identify risk/test gaps.

Deliver:

- `evaluate` command;
- `risks` command;
- requirement coverage statuses;
- direct/indirect test evidence;
- overreach detection;
- risk register;
- suggested manual/automatic checks.

Dogfood:

- evaluate current branch against `features/review-surfaces.feature.yaml`;
- use findings to improve tests and scope boundaries.

### M4: Architecture diagrams

Goal: make changed systems easier to review.

Deliver:

- `diagrams` command;
- Mermaid high-level diagram;
- subsystem map;
- flow diagram;
- per-subsystem cards;
- diagram validation.

Dogfood:

- review whether `review-surfaces` module boundaries are understandable;
- adjust architecture or packet rendering if diagrams are noisy.

### M5: Methodology audit, dogfood manager, handoff

Goal: evaluate the process and improve agent continuity.

Deliver:

- `methodology` command;
- normalized log support;
- claimed-vs-verified test separation;
- `dogfood` command;
- feedback ingestion;
- `agent_handoff.md` generation.

Dogfood:

- use handoff to start the next implementation slice;
- record whether the handoff actually reduced context reconstruction.

### M6: Reviewer brief and CI/PR integration

Goal: expose local review artifacts through code-hosting workflows without
turning the whole-repo packet into the default PR review surface.

Delivered shape:

- GitHub Action using a trusted-tool checkout and credentialless PR subject
  checkout, with any secret-bearing provider enrichment isolated to trusted
  orchestration and never required for the reviewer brief;
- `all --review-scope pr` generation of deterministic current-head facts and the
  human reviewer model;
- sticky PR comment renderer with `comment --review-scope pr --format sticky`;
- `pr_review_surface.json` sidecar schema;
- PR comments lead with a truthful verdict, author-provided change purpose, and
  every independently rooted approval decision, and remain postable with the
  mock provider or no provider enrichment;
- narrative, provider state, diagrams, maps, reading tours, and repository-wide
  compliance details remain optional supporting material rather than occupying
  or gating the primary scan path;
- optional GitLab/Gerrit adapters;
- optional SARIF export;
- optional Acai CLI/API sync.

Constraint:

- M6 must not require changing the `review_packet.json` core artifact contract.

---

## 17. First implementation slice for Codex

The first implementation should not attempt the full product. It should create a working skeleton and one deterministic vertical slice.

Recommended first slice:

1. Create TypeScript package scaffold.
2. Add CLI entrypoint with `--help` and command dispatch.
3. Add config loader.
4. Add Acai feature parser.
5. Add ACID generation.
6. Add review packet schema validation.
7. Add `collect` command that writes `manifest.json`, `inputs/specs.index.json`, and `inputs/changed_files.json`.
8. Add tests and fixtures.
9. Add a skeleton `review_packet.json` and `review_packet.md` with unknowns for unimplemented modules.
10. Run dogfood mode and record limitations in `.review-surfaces/dogfood.yaml`.

This gives the project a real self-use loop before any LLM-heavy modules are implemented.

---

## 18. LLM prompt contracts

All LLM modules should receive:

- explicit JSON/YAML schema;
- bounded inputs;
- evidence candidates;
- instruction to mark missing evidence as unknown;
- no permission to invent paths, tests, commands, or event IDs.

### 18.1 Intent prompt contract

```text
Given indexed specs, docs, plans, and normalized conversation summaries, produce intent.yaml.
Every requirement must cite a source. Preserve ACIDs. If sources conflict, add an open question. If evidence is sparse, mark assumptions.
```

### 18.2 Evaluator prompt contract

```text
Given intent requirements, changed files, diff summaries, test evidence, and source references, classify each requirement as satisfied, partial, missing, unknown, overreach, or invalid_evidence. Cite only provided evidence candidates. Do not invent file paths or test names.
```

### 18.3 Methodology prompt contract

```text
Given normalized conversation/tool events, summarize decisions, research, alternatives, skipped checks, claims, verified actions, and unchallenged assumptions. Cite event IDs. Mark missing logs explicitly.
```

---

## 19. Open decisions

These can be decided during implementation:

1. Package name: `review-surfaces`, `review-packet`, or another name.
2. Whether artifact YAML schemas should be separate files or derived from TypeScript types.
3. Exact TypeScript schema library: Zod, TypeBox, Valibot, or JSON Schema first.
4. Whether Mermaid validation uses a dependency or text-level validation first.
5. ~~Which conversation log adapters to support first.~~ RESOLVED (conversation-audit uplift, docs/history/CONVERSATION_AUDIT_UPLIFT_GOAL.md): all three harnesses are first-class — Claude Code (reference/dogfood-validated), Codex, and Cursor — via a pluggable adapter registry (`src/conversation/`), none deferred. Claude Code is the reference adapter; Codex and Cursor are explicitly best-effort (version-variable on-disk shapes) and degrade to no-match rather than mis-normalize. See §8.3.
6. Whether Acai CLI sync belongs in M6 or a separate M7.
7. Whether `review_packet.json` should embed all sections or reference per-file artifacts.

Bootstrap recommendation: choose simple defaults and preserve extension points rather than over-designing.

---

## 20. Definition of a useful MVP

The MVP is useful when a reviewer can run one local command and receive:

- source-backed intent;
- requirement coverage with evidence;
- clear missing tests;
- architecture decomposition for changed files;
- known methodology gaps if logs exist or are missing;
- a compact review focus;
- a handoff note for the next agent.

The MVP is not useful if it only produces a generic AI summary of a diff.

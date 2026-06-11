import fs from "node:fs";
import path from "node:path";
import { fileExists } from "../core/files";
import { redactSecrets } from "../privacy/secrets";
import { isHypothesisOnly } from "../evidence/evidence";
import { countRequirementStatuses, formatRequirementStatusSummary } from "../evaluation/status";
import { validateMermaidDiagramArtifact } from "../diagrams/diagrams";
import type { ReviewPacket } from "./packet";

// ---------------------------------------------------------------------------
// Phase 6a: GitHub STICKY-COMMENT renderer (PROVIDERS.1; M6).
//
// This is a RENDERER, not a pipeline stage. It READS the local
// review_packet.json artifact and emits a compact GitHub Markdown comment.
// Hard M6 constraints honored here:
//   - It never recomputes the pipeline (no intent/evaluate/risks logic runs).
//   - It never redefines the core artifact contract; it only consumes the
//     already-written ReviewPacket shape.
//   - The default path requires no network/hosted access; it just reads a file.
//
// The first line is an HTML comment carrying review-surfaces:sticky so CI (or a
// later `--post` path) can find-and-upsert a single sticky comment per PR.
// Output is byte-deterministic: same packet in -> same comment out (no clock,
// no environment), and every section is capped so the comment stays well under
// a typical PR comment size.
// ---------------------------------------------------------------------------

export const STICKY_MARKER = "<!-- review-surfaces:sticky -->";

// Per-section caps keep the comment review-sized. These are deliberately small:
// the comment is a pointer to the full local packet, not a replacement for it.
const MAX_REVIEW_FOCUS = 5;
const MAX_RISKS = 5;
const MAX_NON_SATISFIED = 6;
const MAX_HYPOTHESES = 6;

// Per-line and total length bounds. Item COUNT caps alone do not bound the
// comment: free-text fields (risk/result summaries, requirement text, file
// paths) are partly user/agent-controlled and can be arbitrarily long, so each
// interpolated line is truncated and the assembled comment is hard-capped well
// under GitHub's ~65,536-char per-comment limit. Without these, a single
// oversized summary or path could blow past the limit and a later --post would
// silently fail to upsert.
const MAX_LINE_CHARS = 300;
const MAX_COMMENT_CHARS = 60000;

// Architecture diagrams are embedded as GitHub-rendered ```mermaid blocks so a
// reviewer can SEE the changed-architecture surfaces directly on the PR. Only
// VALID diagrams are embedded (an invalid one would render as a parse error);
// each is wrapped in <details> to keep the sticky comment scannable. Bounds keep
// the section review-sized (a big repo's source-layout diagram stays well under
// GitHub's per-comment limit). An over-budget or invalid diagram is OMITTED with
// a count, never truncated — a half Mermaid block renders as an error on GitHub.
const MAX_DIAGRAMS = 6;
const MAX_DIAGRAM_CHARS = 4000;
const MAX_DIAGRAM_SECTION_CHARS = 12000;

// A validated Mermaid diagram to embed: a human title and the raw .mmd body.
export interface DiagramEmbed {
  title: string;
  body: string;
}

// Default artifact-dir relative paths used when renderComment is called without
// a resolved packet location (the pure in-memory path). The CLI path threads the
// EFFECTIVE output dir so a custom output_dir is reflected in the pointer.
const DEFAULT_PACKET_JSON_REL = ".review-surfaces/review_packet.json";
const DEFAULT_PACKET_MD_REL = ".review-surfaces/review_packet.md";

// Where the full local packet lives, expressed relative to cwd. Both pointers
// are derived from the SAME effective packet path the renderer read, so a custom
// output_dir is reflected in the published comment instead of a hardcoded
// .review-surfaces link that would point at a non-existent/stale artifact.
interface PacketPointers {
  json: string;
  markdown: string;
}

function defaultPointers(): PacketPointers {
  return { json: DEFAULT_PACKET_JSON_REL, markdown: DEFAULT_PACKET_MD_REL };
}

export interface RenderedComment {
  markdown: string;
  packetPath: string;
}

/**
 * Resolve the review_packet.json path under an output directory (default
 * .review-surfaces, honoring --out). A directory resolves to
 * <dir>/review_packet.json; an explicit .json path is used as-is.
 */
export function resolvePacketPath(cwd: string, outDir?: string): string {
  const base = path.resolve(cwd, outDir ?? ".review-surfaces");
  return base.endsWith(".json") ? base : path.join(base, "review_packet.json");
}

/**
 * Load the local review_packet.json and render a compact sticky GitHub comment.
 * Returns null when the packet is absent so the caller can emit a clean usage
 * error suggesting `review-surfaces all` WITHOUT recomputing anything here.
 */
export function renderCommentFromPacketFile(cwd: string, outDir?: string): RenderedComment | null {
  const packetPath = resolvePacketPath(cwd, outDir);
  if (!fileExists(packetPath)) {
    return null;
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")) as ReviewPacket;
  // Read the VALID Mermaid bodies from <outDir>/diagrams/*.mmd (the packet JSON
  // carries only paths + validation status, not the bodies). This sibling-file
  // read is the only IO; renderComment stays pure given the loaded diagrams.
  const diagrams = loadEmbeddedDiagrams(path.dirname(packetPath), packet);
  return {
    // Derive the "full packet" pointers from the EFFECTIVE packet path the
    // renderer actually read, expressed relative to cwd, so a repo with a custom
    // output_dir gets a link to the REAL artifact location rather than a
    // hardcoded .review-surfaces/review_packet.* that does not exist there.
    markdown: renderComment(packet, pointersForPacketPath(cwd, packetPath), diagrams),
    packetPath
  };
}

// Load the VALID diagrams referenced by the packet from their .mmd sibling files
// under outDir. Only diagrams the pipeline validated as `valid` are embedded, and
// the read is confined to genuine regular files whose REAL path stays under the
// real <outDir>/diagrams directory — defense against a tampered packet (run via
// `comment --post` over a reused/untrusted output dir) pointing the renderer at
// an arbitrary file through a symlinked .mmd or a symlinked diagrams/ ancestor.
function loadEmbeddedDiagrams(outDir: string, packet: ReviewPacket): DiagramEmbed[] {
  const embeds: DiagramEmbed[] = [];
  // The expected real diagrams root: realpath(outDir) + "/diagrams". Built by
  // string-join (NOT realpath of diagrams/ itself) so a symlinked diagrams/ dir
  // resolves OUTSIDE this root and is rejected below, rather than being followed.
  let expectedDiagramsDir: string;
  try {
    expectedDiagramsDir = path.join(fs.realpathSync(outDir), "diagrams");
  } catch {
    return embeds;
  }
  for (const diagram of packet.architecture?.diagram_validation ?? []) {
    if (diagram.status !== "valid") {
      continue;
    }
    const rel = diagram.path;
    if (typeof rel !== "string" || path.isAbsolute(rel) || rel.includes("..") || !rel.startsWith("diagrams/") || !rel.endsWith(".mmd")) {
      continue;
    }
    const file = path.join(outDir, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    // Skip non-files (symlink final component / directories) AND oversize files
    // BEFORE reading: a packet can mark a huge .mmd `valid`, and reading it before
    // the MAX_DIAGRAM_CHARS check would waste memory on a body we then drop.
    if (!stat.isFile() || stat.size > MAX_DIAGRAM_CHARS) {
      continue;
    }
    // Confine the fully-resolved real path under the real diagrams root. This
    // rejects a symlinked .mmd or a symlinked ANCESTOR whose target escapes the
    // diagrams directory (lstat alone only guards the final path component).
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    const within = path.relative(expectedDiagramsDir, real);
    if (within === "" || within.startsWith("..") || path.isAbsolute(within)) {
      continue;
    }
    const body = fs.readFileSync(file, "utf8").trim();
    if (body === "") {
      continue;
    }
    // Re-validate the CURRENT bytes rather than trusting the packet's recorded
    // status: a .mmd modified/stale since generation could now be invalid Mermaid
    // and would render as the parse-error block this feature exists to avoid.
    if (validateMermaidDiagramArtifact({ path: rel, body }).status !== "valid") {
      continue;
    }
    embeds.push({ title: diagramTitle(rel), body });
  }
  return embeds;
}

// "diagrams/source-layout.mmd" -> "Source layout".
function diagramTitle(rel: string): string {
  const base = rel.replace(/^diagrams\//, "").replace(/\.mmd$/, "").replace(/[-_]+/g, " ").trim();
  return base === "" ? "Diagram" : base.charAt(0).toUpperCase() + base.slice(1);
}

// review_packet.json -> {json, markdown} pointers, relative to cwd. The json
// path is the packet the renderer read; the markdown path is its .md sibling in
// the same directory (the human-readable surface `all` also writes there).
function pointersForPacketPath(cwd: string, packetPath: string): PacketPointers {
  const dir = path.dirname(packetPath);
  const jsonRel = path.relative(cwd, packetPath) || packetPath;
  const mdRel = path.relative(cwd, path.join(dir, "review_packet.md")) || path.join(dir, "review_packet.md");
  return { json: jsonRel, markdown: mdRel };
}

/**
 * Render the compact sticky comment from an in-memory packet. Pure: no IO, no
 * clock, deterministic given the packet. Secrets are redacted in every rendered
 * free-text line, mirroring the packet markdown renderer.
 */
export function renderComment(
  packet: ReviewPacket,
  pointers: PacketPointers = defaultPointers(),
  diagrams: DiagramEmbed[] = []
): string {
  const counts = countRequirementStatuses(packet.evaluation.results ?? []);
  const overreachCount = packet.evaluation.overreach?.length ?? 0;
  const milestone = readMilestone(packet);

  const sections: string[] = [
    STICKY_MARKER,
    `## review-surfaces${milestone ? ` (${redact(milestone)})` : ""}`,
    `Status: ${formatRequirementStatusSummary(counts, overreachCount)}.`,
    "",
    "### Top review focus",
    renderBullets(reviewFocus(packet, MAX_REVIEW_FOCUS), "No review focus generated."),
    "",
    "### Top risks",
    renderBullets(topRisks(packet, MAX_RISKS), "No risks recorded."),
    "",
    // review-surfaces.COLD_START.5: a spec-less packet renders the honest note,
    // never "0 requirement result(s)"-style zero counts.
    "### Requirement coverage",
    ...((packet.intent as { spec_mode?: unknown }).spec_mode === "none"
      ? ["No requirement spec configured — intent checks are limited to docs and constraints."]
      : [renderBullets(coverageLines(packet, counts, overreachCount), "No requirements indexed.")]),
    "",
    "### LLM/agent hypotheses (NOT proof; verify against deterministic evidence)",
    renderBullets(hypotheses(packet, MAX_HYPOTHESES), "None proposed."),
    // GitHub renders these ```mermaid blocks inline so reviewers see the changed
    // architecture surfaces directly on the PR. Empty when no valid diagrams.
    ...renderDiagramSection(diagrams),
    "",
    // Point reviewers at the REAL artifact location (the effective output_dir),
    // not a hardcoded .review-surfaces path that would be stale/absent in a repo
    // with a configured output_dir.
    `Full local packet: \`${pointers.markdown}\` (machine-readable: \`${pointers.json}\`).`
  ];

  // Single trailing newline so two renders of the same packet are byte-identical.
  // Per-line truncation already bounds each interpolated field; the total cap is a
  // belt-and-suspenders guarantee (many capped lines could still add up) that the
  // assembled comment stays under GitHub's per-comment limit.
  return clampTotal(`${sections.join("\n")}\n`, pointers.json);
}

// Hard-cap the assembled comment so it can never exceed GitHub's per-comment
// limit. Deterministic: same input -> same (possibly truncated) output. The
// trailer points the reviewer at the full local packet at its REAL (effective
// output_dir) location, not a hardcoded .review-surfaces path.
function clampTotal(markdown: string, packetJsonRel: string): string {
  if (markdown.length <= MAX_COMMENT_CHARS) {
    return markdown;
  }
  const trailer = `\n\n... truncated; see \`${packetJsonRel}\` for the full packet.\n`;
  const budget = MAX_COMMENT_CHARS - trailer.length;
  return `${markdown.slice(0, budget)}${trailer}`;
}

// Truncate a single interpolated free-text field to a sane per-line length so a
// pathological summary/path/requirement can't blow up the comment. Deterministic
// and newline-collapsing so one field can't smuggle extra markdown lines in.
//
// FINDING C (SECRET LEAK): this MUST NOT be called on raw free text before
// redaction. Block secrets (e.g. a multi-line `-----BEGIN ... PRIVATE KEY-----`
// ... `-----END ... PRIVATE KEY-----` block) are only matched by redactSecrets
// when the WHOLE block is present, but the display cap collapses whitespace and
// truncates to MAX_LINE_CHARS -- a truncated block no longer matches, so the
// first ~300 chars of the key would survive into comment.md and the posted PR
// comment. Always redact the FULL field FIRST (`renderField`), then truncate.
function truncateField(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_LINE_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, MAX_LINE_CHARS - 1)}…`;
}

// FINDING C: the ONLY safe ordering for an interpolated free-text line is
// redact-the-FULL-text-then-truncate. Redacting first guarantees block secrets
// (private keys, etc.) are replaced while the whole BEGIN...END block is still
// intact; truncating after keeps the comment review-sized. Use this for every
// free-text line in the comment renderer.
function renderField(value: string): string {
  return truncateField(redact(value));
}

function readMilestone(packet: ReviewPacket): string | undefined {
  const milestone = packet.dogfood?.milestone ?? packet.manifest?.milestone;
  return typeof milestone === "string" && milestone.trim() !== "" ? milestone : undefined;
}

function reviewFocus(packet: ReviewPacket, limit: number): string[] {
  // FINDING C: redact the FULL field, THEN truncate (renderField), so a block
  // secret is replaced before the display cap can split it.
  return (packet.risks?.review_focus ?? []).slice(0, limit).map((item) => renderField(item));
}

// Mirror the SARIF renderer: the deterministic "Top risks" list excludes risk
// items whose evidence is entirely LLM-proposed. Those hypotheses are already
// surfaced (clearly labeled) under the dedicated hypotheses section, so they must
// not be intermixed with deterministic findings here (review-surfaces.EVIDENCE.6).
function topRisks(packet: ReviewPacket, limit: number): string[] {
  return (packet.risks?.items ?? [])
    .filter((risk) => !isHypothesisOnly(risk.evidence))
    .slice(0, limit)
    // FINDING C: redact the FULL line (with the untruncated summary), THEN truncate.
    .map((risk) => renderField(`${risk.id} [${risk.severity}]: ${risk.summary}`));
}

// Compact coverage: the count summary line plus a few NON-satisfied requirement
// statuses (the ones a reviewer should look at first). Capped and overflow-noted.
function coverageLines(
  packet: ReviewPacket,
  counts: ReturnType<typeof countRequirementStatuses>,
  overreachCount: number
): string[] {
  const lines: string[] = [
    `satisfied ${counts.satisfied} | partial ${counts.partial} | missing ${counts.missing} | unknown ${counts.unknown} | invalid_evidence ${counts.invalid_evidence} | overreach ${overreachCount}`
  ];
  const nonSatisfied = (packet.evaluation.results ?? []).filter((result) => result.status !== "satisfied");
  for (const result of nonSatisfied.slice(0, MAX_NON_SATISFIED)) {
    const id = result.acai_id ?? result.requirement_id;
    // FINDING C: redact the FULL line (with the untruncated summary), THEN truncate.
    lines.push(renderField(`${id}: ${result.status} - ${result.summary}`));
  }
  if (nonSatisfied.length > MAX_NON_SATISFIED) {
    lines.push(`... ${nonSatisfied.length - MAX_NON_SATISFIED} more in review_packet.json`);
  }
  return lines;
}

// review-surfaces.EVIDENCE.6: surface LLM/agent-proposed material CLEARLY labeled
// as hypotheses (the section header says so) and never presented as proof.
function hypotheses(packet: ReviewPacket, limit: number): string[] {
  // FINDING C: build the lines with the FULL (untruncated) free text, then
  // redact-the-full-line-THEN-truncate (renderField) below. The previous code
  // truncated each field while assembling and only redacted afterwards, so a block
  // secret split by the display cap escaped redaction.
  const lines: string[] = [];
  for (const requirement of packet.intent?.requirements ?? []) {
    if (requirement.llm_derived) {
      lines.push(`requirement ${requirement.id}: ${requirement.requirement}`);
    }
  }
  for (const result of packet.evaluation?.results ?? []) {
    for (const ref of [...(result.evidence ?? []), ...(result.missing_evidence ?? [])]) {
      if (ref.llm_proposed === true) {
        lines.push(`${result.acai_id ?? result.requirement_id} [${ref.validation_status ?? "unknown"}]: ${ref.path ?? ref.note ?? ref.kind}`);
      }
    }
  }
  for (const item of packet.risks?.items ?? []) {
    if ((item.evidence ?? []).some((ref) => ref.llm_proposed === true)) {
      lines.push(`${item.id}: ${item.summary}`);
    }
  }
  const visible = lines.slice(0, limit).map((line) => renderField(line));
  if (lines.length > limit) {
    visible.push(`... ${lines.length - limit} more in review_packet.json`);
  }
  return visible;
}

// Build the "Architecture diagrams" section: each valid diagram as a
// <details>-wrapped ```mermaid block GitHub renders inline. Bodies are redacted
// (constant substitution preserves valid Mermaid) but NEVER per-line-truncated
// or split — a partial Mermaid block renders as a parse error. Over-budget,
// over-size, or beyond-MAX_DIAGRAMS entries are dropped WHOLE and counted, so the
// section is bounded without ever emitting a broken diagram. Returns [] (no
// section) when there is nothing renderable.
function renderDiagramSection(diagrams: DiagramEmbed[]): string[] {
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const diagram of diagrams) {
    if (blocks.length >= MAX_DIAGRAMS) {
      omitted += 1;
      continue;
    }
    const body = redact(diagram.body);
    // Self-defend rather than trust the upstream validator: omit (never embed) a
    // body that is over-size OR contains a line that would CLOSE the ```mermaid
    // fence (a line-leading ``` ), which would spill the remainder into raw
    // markdown/HTML on the PR. The built-in generators never emit this, but
    // renderComment/DiagramEmbed are public API and a future/external .mmd writer
    // could. The body itself is NOT html-escaped: GitHub renders fenced content
    // verbatim, and escaping would corrupt Mermaid arrows (`-->` -> `--&gt;`).
    if (body.length > MAX_DIAGRAM_CHARS || /^\s*```/m.test(body)) {
      omitted += 1;
      continue;
    }
    // The TITLE lands in an HTML <summary>, so it MUST be html-escaped (a caller
    // could supply a title containing </summary>...<img onerror=...>).
    const title = htmlEscape(truncateField(redact(diagram.title)));
    const block = `<details><summary>${title}</summary>\n\n\`\`\`mermaid\n${body}\n\`\`\`\n\n</details>`;
    if (used + block.length > MAX_DIAGRAM_SECTION_CHARS) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0) {
    return [];
  }
  const lines = ["", "### Architecture diagrams", ...blocks];
  if (omitted > 0) {
    lines.push(`_${omitted} more diagram(s) omitted to keep the comment compact; see the local \`diagrams/\` artifacts._`);
  }
  return lines;
}

function renderBullets(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return `- ${emptyText}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function redact(value: string): string {
  return redactSecrets(value).text;
}

// Neutralize HTML so an interpolated value (e.g. a diagram title) cannot inject
// markup into the <summary>/<details> wrapper of the posted comment.
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

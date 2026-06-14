// review-surfaces.RENDER.9/.10: the single-file HTML cockpit. A STRICT SIBLING
// of the markdown renderer: it consumes the HumanReviewModel (plus the same
// optional render-time diff context the markdown renderer uses for bounded hunk
// excerpts) and nothing else — if the HTML ever needs data the model lacks, the
// model and strict schema grow first so JSON/MD/HTML can never diverge.
//
// Hard rules: zero dependencies (inline CSS + a little vanilla JS — collapse,
// lens filter, localStorage-persisted checkboxes), every interpolation passes
// through esc() after secret redaction, byte-deterministic output (no
// timestamps), opens from disk offline, printable.
import { resolveStructuredExcerpt, ExcerptRedactionState } from "./hunk-excerpt";
import { containsBlockedRedaction } from "../privacy/secrets";
import { decisionLabel, formatQueueLocation, HumanRenderContext, rankingReasonsAreDefaultOnly, collapseReadingOrderWhy } from "./render";
import { coverageHunkForAnchor, coverageSummaryLine } from "./coverage-gutter";
import { renderChangeMapOverviewSvg, renderChangeMapSvg, SVG_LENS_FILLS } from "./render-svg-map";
import { changeMapLeadLevel } from "./legibility-budget";
import { buildGroupDetailViews, detailViewSubGraph } from "./change-graph";
// Redact-then-escape: EVERY interpolated value goes through this shared helper
// (lifted to esc.ts so the SVG emitter uses the same one — RENDER.11).
import { esc } from "./esc";
import { RISK_LENS_METADATA } from "./contract";
import type { CoverageEvidenceHunk, HumanReviewModel, ReviewQueueItem } from "./contract";
import type { EvidenceRef } from "../evidence/evidence";

export function renderHumanReviewHtml(model: HumanReviewModel, context: HumanRenderContext = {}): string {
  const lenses = [...new Set(model.review_queue.flatMap((item) => lensesForItem(model, item)))].sort();
  // review-surfaces.PRIVACY.6: render the queue first with a redaction sink so a
  // high-confidence secret in any diff excerpt is observed, not silently dropped.
  const excerptRedaction: ExcerptRedactionState = { blocked: false };
  const queueHtml = model.review_queue.length === 0
    ? `<p class="muted">No path-backed review queue items.</p>`
    : model.review_queue.map((item) => renderQueueItem(model, item, context, excerptRedaction)).join("\n");
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>review-surfaces — human review</title>
<style>
:root { --fg:#1c1c1c; --muted:#666; --line:#ddd; --accent:#0b5fff; --bad:#b00020; --warn:#9a6700; --ok:#1a7f37; }
* { box-sizing: border-box; }
body { margin:0 auto; max-width: 980px; padding: 2rem 1.25rem 4rem; color: var(--fg); font: 15px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; border-bottom: 1px solid var(--line); padding-bottom: .3rem; }
code, pre { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background:#f6f8fa; border:1px solid var(--line); border-radius:6px; padding:.6rem .8rem; overflow-x:auto; }
.muted { color: var(--muted); }
.badge { display:inline-block; border-radius: 10px; padding: .05rem .55rem; font-size: .78rem; border:1px solid var(--line); }
.badge.blocker, .badge.high, .badge.block_before_merge { color:var(--bad); border-color:var(--bad); }
.badge.medium, .badge.needs_author_clarification, .badge.reviewable_with_attention { color:var(--warn); border-color:var(--warn); }
.badge.low, .badge.probably_safe, .badge.covered { color:var(--ok); border-color:var(--ok); }
.item { border:1px solid var(--line); border-radius:8px; padding: .7rem .9rem; margin: .6rem 0; }
.item.done { opacity:.55; }
.item header { display:flex; gap:.6rem; align-items:baseline; }
.item header label { margin-left:auto; font-size:.8rem; color:var(--muted); white-space:nowrap; }
details > summary { cursor:pointer; color:var(--accent); font-size:.85rem; }
ul { padding-left: 1.2rem; }
.filters button { margin: 0 .35rem .35rem 0; border:1px solid var(--line); background:#fff; border-radius:14px; padding:.2rem .7rem; cursor:pointer; font-size:.8rem; }
.filters button.active { border-color: var(--accent); color: var(--accent); }
a { color: var(--accent); }
@media print { #file-filter-note, .item header label { display:none; } details > * { display:block; } }
</style>
</head>
<body>
<h1>Human review</h1>
<p class="muted">Generated from <code>${esc(model.generated_from.packet_path)}</code> · <code>${esc(model.generated_from.base_ref)}</code> → <code>${esc(model.generated_from.head_ref)}</code> @ <code>${esc(model.generated_from.head_sha)}</code>${model.generated_from.uncommitted_files > 0 ? ` · includes ${model.generated_from.uncommitted_files} uncommitted file(s) (working tree)` : ""}</p>

<h2 id="verdict">Verdict</h2>
<p><span class="badge ${esc(model.verdict.decision)}">${esc(decisionLabel(model.verdict.decision))}</span> <span class="muted">confidence: ${esc(model.verdict.confidence)}</span></p>
<p>${esc(model.summary)}</p>
${renderHeaderStrip(model, lenses)}
${renderThreeQuestions(model)}
<h2 id="reading-order">Reading order</h2>
${renderReadingOrder(model)}

<h2 id="map">Change map</h2>
${renderSvgMapSection(model)}

${renderNarrative(model)}
${renderBlockers(model)}

<h2 id="queue">Review queue</h2>
<p class="filters" id="file-filter-note" hidden>Filtered to <code id="file-filter-path"></code> <button data-clear-file-filter>show all</button></p>
${queueHtml}

<h2 id="plan">Review plan</h2>
${renderPlan(model)}

<h2 id="coverage">Coverage evidence</h2>
${renderCoverage(model)}

<h2 id="cards">Evidence cards</h2>
${renderCards(model)}

<h2 id="dep-chains" ${model.dependency_chains?.length ? "" : "hidden"}>Dependency chains</h2>
${renderDependencyChains(model)}

<h2 id="rounds">Review rounds</h2>
${renderRounds(model)}

<h2 id="trust">Trust audit</h2>
${renderTrust(model)}

<h2 id="questions">Questions for the author</h2>
${model.questions.length === 0 ? `<p class="muted">No reviewer questions generated.</p>` : `<ul>${model.questions.map((question) => `<li><span class="badge ${esc(question.severity)}">${esc(question.severity)}</span> ${esc(question.question)} <span class="muted">(${esc(question.id)})</span></li>`).join("")}</ul>`}

${renderScoreboardFooter(model)}
<script>
(function () {
  "use strict";
  var KEY = "review-surfaces:checked:${esc(model.generated_from.head_sha)}";
  var checked = {};
  try { checked = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { checked = {}; }
  Array.prototype.forEach.call(document.querySelectorAll("[data-queue-check]"), function (box) {
    var id = box.getAttribute("data-queue-check");
    box.checked = Boolean(checked[id]);
    box.closest(".item").classList.toggle("done", box.checked);
    box.addEventListener("change", function () {
      checked[id] = box.checked;
      box.closest(".item").classList.toggle("done", box.checked);
      try { localStorage.setItem(KEY, JSON.stringify(checked)); } catch (e) { /* private mode */ }
    });
  });
  // Lens and map-file filters COMPOSE: an item is visible only when it passes
  // both active filters (intersection), so toggling one never un-hides items
  // the other filtered out.
  var activeLens = null;
  var activeFile = null;
  var activeFileOld = null;
  var fileNote = document.getElementById("file-filter-note");
  var filePathEl = document.getElementById("file-filter-path");
  function applyFilters() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-lenses]"), function (item) {
      var lensOk = !activeLens || activeLens === "all" || (" " + item.getAttribute("data-lenses") + " ").indexOf(" " + activeLens + " ") >= 0;
      // Rename-aware: an old-side-anchored item (path = rename source) matches
      // the map node of its renamed destination, and vice versa.
      var itemPath = item.getAttribute("data-path");
      var fileOk = !activeFile || itemPath === activeFile || item.getAttribute("data-path-old") === activeFile || (activeFileOld && itemPath === activeFileOld);
      item.style.display = lensOk && fileOk ? "" : "none";
    });
    if (fileNote && filePathEl) {
      fileNote.hidden = !activeFile;
      filePathEl.textContent = activeFile || "";
    }
  }
  var buttons = document.querySelectorAll("[data-lens-filter]");
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener("click", function () {
      var lens = button.getAttribute("data-lens-filter");
      var active = button.classList.toggle("active");
      Array.prototype.forEach.call(buttons, function (other) { if (other !== button) { other.classList.remove("active"); } });
      activeLens = active ? lens : null;
      applyFilters();
    });
  });
  // review-surfaces.RENDER.12: review-progress bar fed by the existing
  // checkbox state — recomputed on every change.
  function updateProgress() {
    var boxes = document.querySelectorAll("[data-queue-check]");
    var done = 0;
    Array.prototype.forEach.call(boxes, function (box) { if (box.checked) { done += 1; } });
    var bar = document.getElementById("progress-bar");
    var label = document.getElementById("progress-label");
    if (bar && label && boxes.length > 0) {
      bar.style.width = Math.round((done / boxes.length) * 100) + "%";
      label.textContent = done + " of " + boxes.length + " reviewed";
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-queue-check]"), function (box) {
    box.addEventListener("change", updateProgress);
  });
  updateProgress();
  // review-surfaces.RENDER.11: clicking a map node filters the queue to that
  // file (same data- attribute pattern as the lens filters; composes with the
  // lens filter via applyFilters above).
  Array.prototype.forEach.call(document.querySelectorAll("[data-map-file]"), function (node) {
    node.addEventListener("click", function () {
      var file = node.getAttribute("data-map-file");
      if (activeFile === file) {
        activeFile = null;
        activeFileOld = null;
      } else {
        activeFile = file;
        activeFileOld = node.getAttribute("data-map-file-old");
      }
      applyFilters();
    });
  });
  var clearButton = document.querySelector("[data-clear-file-filter]");
  if (clearButton) {
    clearButton.addEventListener("click", function () { activeFile = null; activeFileOld = null; applyFilters(); });
  }
  // review-surfaces.MAP_SCALE.6: clicking an overview group toggles its
  // pre-rendered hidden detail SVG (one open at a time; clicking the same
  // group again closes it). Same data- attribute pattern as the filters.
  Array.prototype.forEach.call(document.querySelectorAll("[data-map-group]"), function (card) {
    card.addEventListener("click", function () {
      var group = card.getAttribute("data-map-group");
      Array.prototype.forEach.call(document.querySelectorAll("[data-map-detail]"), function (panel) {
        if (panel.getAttribute("data-map-detail") === group) {
          panel.hidden = !panel.hidden;
        } else {
          panel.hidden = true;
        }
      });
    });
  });
})();
</script>
</body>
</html>
`;
  // review-surfaces.PRIVACY.6: the persisted cockpit held BLOCKED material if any
  // diff excerpt raised the block signal, OR any esc()'d model field (summary,
  // narrative, reasons, cards, SVG labels) was redacted to a high-confidence
  // marker. Surface one deterministic, greppable notice in either case.
  const blocked = excerptRedaction.blocked || containsBlockedRedaction(body);
  if (!blocked) {
    return body;
  }
  const notice = `<p class="muted" data-excerpt-redaction="blocked">⚠ A high-confidence secret was redacted from this review.</p>`;
  return body.replace("<h1>Human review</h1>", `<h1>Human review</h1>\n${notice}`);
}

function lensesForItem(model: HumanReviewModel, item: ReviewQueueItem): string[] {
  // Deduped: several findings with the same lens on one item must count the
  // item ONCE per lens chip.
  return [...new Set(
    model.risk_lens_findings
      .filter((finding) => finding.risk_ids.some((id) => item.risk_ids.includes(id)) || finding.paths.includes(item.path))
      .map((finding) => finding.lens)
  )];
}

// review-surfaces.RENDER.12: the at-a-glance header strip, rendered purely from
// existing model fields — lens chips with counts that ARE the filter buttons,
// the review_plan read/skim/defer cut as a stacked CSS bar with minutes, trust
// counts, and a progress bar fed by the persisted checkbox state. Every chip
// and bar segment carries a text label, so color never carries meaning alone.
function renderHeaderStrip(model: HumanReviewModel, lenses: string[]): string {
  const lensCounts = new Map<string, number>();
  for (const item of model.review_queue) {
    for (const lens of lensesForItem(model, item)) {
      lensCounts.set(lens, (lensCounts.get(lens) ?? 0) + 1);
    }
  }
  const chips =
    lenses.length === 0
      ? ""
      : `<p class="filters">${["all", ...lenses]
          .map((lens) => {
            const label = lens === "all" ? "All lenses" : RISK_LENS_METADATA[lens as keyof typeof RISK_LENS_METADATA]?.label ?? lens;
            const count = lens === "all" ? model.review_queue.length : lensCounts.get(lens) ?? 0;
            return `<button data-lens-filter="${esc(lens)}">${esc(label)} (${esc(count)})</button>`;
          })
          .join("")}</p>`;

  const plan = model.review_plan;
  let budgetBar = "";
  if (plan && plan.enabled) {
    const minutes = (items: typeof plan.read): number => items.reduce((sum, entry) => sum + (entry.estimated_minutes ?? 0), 0);
    const read = minutes(plan.read);
    const skim = minutes(plan.skim);
    const defer = minutes(plan.defer);
    const total = Math.max(1, read + skim + defer);
    const segment = (label: string, value: number, background: string): string =>
      value <= 0
        ? ""
        : `<span style="display:inline-block;width:${Math.max(6, Math.round((value / total) * 100))}%;background:${background};padding:.15rem .3rem;overflow:hidden;white-space:nowrap;font-size:.75rem">${esc(label)} ${esc(value)}m</span>`;
    budgetBar = `<div class="strip-bar" style="display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:.4rem 0">${segment("read", read, "#d1fae5")}${segment("skim", skim, "#fef9c3")}${segment("defer", defer, "#e5e7eb")}</div>`;
  }

  const trust = model.trust_audit;
  const trustLine = `<p class="muted">✓ ${esc(trust.verified_facts.length)} verified · ~ ${esc(trust.claimed_not_verified.length)} claimed · ${esc(trust.missing_evidence.length)} missing evidence · ${esc(trust.invalid_evidence.length)} invalid</p>`;
  const progress =
    model.review_queue.length > 0
      ? `<div style="border:1px solid var(--line);border-radius:6px;overflow:hidden;height:10px;margin:.2rem 0"><div id="progress-bar" style="height:100%;width:0;background:#1a7f37"></div></div><p class="muted" id="progress-label">0 of ${esc(model.review_queue.length)} reviewed</p>`
      : "";
  return `<div id="strip">${chips}${budgetBar}${trustLine}${progress}</div>`;
}

// review-surfaces.RENDER.11: the inline SVG map with its text legend; the same
// change_graph model the mermaid emitter draws — never a second graph model.
// review-surfaces.MAP_SCALE.2: the legibility budget decides which level leads
// — the overview SVG summarizes when the file-level map cannot render at full
// size (summarize, never shrink).
function renderSvgMapSection(model: HumanReviewModel): string {
  const level = changeMapLeadLevel(model.change_graph, "svg");
  const rendered = level === "overview" ? renderChangeMapOverviewSvg(model.change_graph.overview) : renderChangeMapSvg(model.change_graph);
  if (!rendered) {
    return `<p class="muted">No changed files to map.</p>`;
  }
  const legend =
    rendered.lenses.length > 0
      ? `<p class="muted">Lenses: ${rendered.lenses
          .map((lens) => `<span style="border-left:10px solid ${SVG_LENS_FILLS[lens]};padding-left:.3rem;margin-right:.6rem">${esc(RISK_LENS_METADATA[lens]?.label ?? lens)}</span>`)
          .join("")}</p>`
      : "";
  if (level === "overview") {
    const overview = model.change_graph.overview;
    // review-surfaces.MAP_SCALE.6: every group's detail SVG is pre-rendered
    // and hidden; clicking the overview card toggles it (vanilla JS, same
    // data- pattern as the existing filters). File nodes inside detail views
    // carry data-map-file, so the existing click-to-filter binding picks them
    // up unchanged.
    const detailLenses = new Set(rendered.lenses);
    const panels: string[] = [];
    for (const view of buildGroupDetailViews(model.change_graph)) {
      const detail = renderChangeMapSvg(detailViewSubGraph(model.change_graph, view), {
        stubs: view.stubs,
        ariaLabel: `Change map detail: ${view.group}`
      });
      if (!detail) {
        continue;
      }
      for (const lens of detail.lenses) {
        detailLenses.add(lens);
      }
      panels.push(
        `<div class="map-detail" data-map-detail="${esc(view.group)}" hidden>` +
          `<p class="muted">Detail — <code>${esc(view.group)}</code>. Click a file to filter the review queue; click the group card again to close.</p>` +
          detail.svg +
          `</div>`
      );
    }
    const combinedLegend =
      detailLenses.size > 0
        ? `<p class="muted">Lenses: ${[...detailLenses]
            .sort()
            .map((lens) => `<span style="border-left:10px solid ${SVG_LENS_FILLS[lens]};padding-left:.3rem;margin-right:.6rem">${esc(RISK_LENS_METADATA[lens]?.label ?? lens)}</span>`)
            .join("")}</p>`
        : "";
    return `<p class="muted">Overview — ${esc(model.change_graph.nodes.length)} changed file(s) across ${esc(overview.groups.length)} group(s); the file-level map exceeds the legibility budget, so groups lead. Click a group to zoom; hover for details.</p>\n${rendered.svg}\n${panels.join("\n")}\n${combinedLegend}`;
  }
  return `${rendered.svg}\n${legend}<p class="muted">Click a node to filter the review queue to that file; hover for details.</p>`;
}

function renderQueueItem(model: HumanReviewModel, item: ReviewQueueItem, context: HumanRenderContext, redaction?: ExcerptRedactionState): string {
  const excerptHtml = renderExcerptWithGutter(model, item, context, redaction);
  const cardLinks = model.evidence_cards
    .filter((card) => card.risk_ids.some((id) => item.risk_ids.includes(id)))
    .map((card) => `<a href="#card-${esc(card.id)}">${esc(card.id)}</a>`)
    .join(" ");
  const lenses = lensesForItem(model, item);
  // review-surfaces.RANKING.5: drop the "Why ranked here" line when it is only the
  // default severity echo (it restates the priority badge above).
  const rankingLine = rankingReasonsAreDefaultOnly(item) ? "" : `\n<p class="muted">Why ranked here: ${esc(item.ranking_reasons.join("; "))}</p>`;
  return `<div class="item" data-lenses="${esc(lenses.join(" "))}" data-path="${esc(item.path)}"${item.old_path ? ` data-path-old="${esc(item.old_path)}"` : ""} id="queue-${esc(item.id)}">
<header><strong>${esc(item.rank)}. <code>${esc(formatQueueLocation(item))}</code></strong> <span class="badge ${esc(item.priority)}">${esc(item.priority)}</span><label><input type="checkbox" data-queue-check="${esc(item.id)}"> reviewed</label></header>
<p>${esc(item.reason)}</p>${rankingLine}
<p>Action: ${esc(item.reviewer_action)}</p>
${excerptHtml}
<p class="muted">Evidence: ${evidenceRefsHtml(item.evidence)}</p>
<p class="muted">${esc(item.id)}${item.risk_ids.length ? ` · risks: ${esc(item.risk_ids.join(", "))}` : ""}${cardLinks ? ` · cards: ` : ""}${cardLinks}</p>
</div>`;
}

// review-surfaces.HUMAN_REVIEW.27: the cockpit's first screen answers the three
// questions the README promises about agent-written code — overreach, weakened
// tests, unbacked claims — each as a count linking to its section, so a reviewer
// sees the trust posture at a glance instead of inferring it from the queue.
function renderThreeQuestions(model: HumanReviewModel): string {
  const specless = model.spec_mode === "none";
  const overreach = model.intent_mismatch?.possible_overreach ?? [];
  const weakening = model.semantic_facts?.test_weakening ?? [];
  const unbacked = model.trust_audit?.claimed_not_verified ?? [];
  const overreachAnswer = specless
    ? "not assessed — no spec indexed"
    : overreach.length === 0
      ? "none — every changed file maps to a stated requirement"
      : `${overreach.length} changed file(s) outside any stated requirement`;
  const weakeningFile = weakening.length > 0 ? ` (${esc(weakening[0].path)}${weakening.length > 1 ? `, +${weakening.length - 1} more` : ""})` : "";
  const weakeningAnswer = weakening.length === 0
    ? "none detected — no deleted/skipped tests or removed assertions"
    : `${weakening.length} test-weakening signal(s)${weakeningFile}`;
  const unbackedAnswer = unbacked.length === 0
    ? "none — no claim lacks backing evidence"
    : `${unbacked.length} claim(s) recorded without proof`;
  return `<div class="three-questions" style="border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem;margin:.6rem 0">
<strong>What a human reviewer needs to know</strong>
<ul style="margin:.3rem 0">
<li><a href="#queue">Did the agent overreach its instructions?</a> — ${esc(overreachAnswer)}</li>
<li><a href="#queue">Did it weaken tests to make them pass?</a> — ${weakening.length === 0 ? esc(weakeningAnswer) : weakeningAnswer}</li>
<li><a href="#trust">Did it claim things it didn't do?</a> — ${esc(unbackedAnswer)}</li>
</ul>
</div>`;
}

// Bounded inline evidence references — the same refs the markdown sibling
// renders per queue item, so deterministic items without an evidence card still
// show their evidence.
function evidenceRefsHtml(evidence: EvidenceRef[]): string {
  if (evidence.length === 0) {
    return `<span class="muted">missing</span>`;
  }
  return evidence
    .slice(0, 4)
    // review-surfaces.HUMAN_REVIEW.27: match the markdown evidence-label fallback
    // order (formatEvidenceRef) so a command/test/note-only anchor shows its id
    // instead of rendering as the bare word "command".
    .map((ref) => `<code>${esc(ref.path ?? ref.acai_id ?? ref.test_name ?? ref.command ?? ref.note ?? ref.kind)}</code>`)
    .join(", ");
}

function renderNarrative(model: HumanReviewModel): string {
  if (!model.narrative || model.narrative.claims.length === 0) {
    return `<p class="muted">No grounded narrative available; rely on the verdict and review queue.</p>`;
  }
  const claims = model.narrative.claims
    .map((claim) => {
      const anchors = claim.anchors.length ? ` <span class="muted">(anchors: ${evidenceRefsHtml(claim.anchors)})</span>` : "";
      const invalid = claim.invalid_anchors.length
        ? ` <span class="muted">[claimed; unverified anchor(s): ${claim.invalid_anchors.map((token) => `<code>${esc(token)}</code>`).join(", ")}]</span>`
        : claim.trust === "claimed"
          ? ` <span class="muted">(claimed — unverified anchor)</span>`
          : "";
      return `<li>${claim.trust === "verified" ? "✓" : "~"} ${esc(claim.text)}${anchors}${invalid}</li>`;
    })
    .join("");
  return `<ul>${claims}</ul>`;
}

// review-surfaces.READING_ORDER.2: the guided tour renders as the section
// after the verdict in the cockpit too (a blocker still leads — the tour
// serves the comprehension pass once the verdict is absorbed).
function renderReadingOrder(model: HumanReviewModel): string {
  const legs = model.reading_order.legs;
  if (legs.length === 0) {
    return `<p class="muted">No changed files to order.</p>`;
  }
  let stepNumber = 0;
  const renderStep = (entry: { step: HumanReviewModel["reading_order"]["legs"][number]["steps"][number]; n: number }): string => {
    const { step, n } = entry;
    const refs = step.queue_refs.length > 0 ? ` <span class="muted">(queue: ${step.queue_refs.map((ref) => esc(ref)).join(", ")})</span>` : "";
    const why = collapseReadingOrderWhy(step.why);
    return `<li value="${n}"><code>${esc(step.path)}</code>${why ? ` — ${esc(why)}` : ""}${refs}</li>`;
  };
  return legs
    .map((leg) => {
      // review-surfaces.READING_ORDER.3: a 50-row reading-order wall buries the
      // ranked queue below it. Show the steps that carry a queue link plus the
      // first step of each leg; collapse the remaining mechanical "imported
      // by N" / "read last" rows behind a <details>. Numbering reflects the true
      // reading position, and the FULL ordered list stays in human_review.md and
      // human_review.json — no data is lost.
      const numbered = leg.steps.map((step) => ({ step, n: (stepNumber += 1) }));
      const visible = numbered.filter((entry, index) => index === 0 || entry.step.queue_refs.length > 0);
      const collapsed = numbered.filter((entry, index) => !(index === 0 || entry.step.queue_refs.length > 0));
      const visibleHtml = visible.map(renderStep).join("");
      const collapsedHtml = collapsed.length > 0
        ? `<details><summary>+${collapsed.length} supporting file(s) in dependency order</summary><ol>${collapsed.map(renderStep).join("")}</ol></details>`
        : "";
      return `<h3>${esc(leg.title)}</h3><ol>${visibleHtml}</ol>${collapsedHtml}`;
    })
    .join("\n");
}

function renderBlockers(model: HumanReviewModel): string {
  if (model.blockers.length === 0) {
    return "";
  }
  return `<h2 id="blockers">Blockers</h2><ul>${model.blockers
    .map((blocker) => `<li><span class="badge blocker">${esc(blocker.severity)}</span> ${esc(blocker.summary)} <em>${esc(blocker.required_action)}</em></li>`)
    .join("")}</ul>`;
}

function renderPlan(model: HumanReviewModel): string {
  const plan = model.review_plan;
  if (!plan || !plan.enabled) {
    return `<p class="muted">No time budget configured (pass <code>--budget 15m</code> or set <code>human_review.review_budget</code>).</p>`;
  }
  const group = (label: string, items: typeof plan.read): string =>
    `<h3>${esc(label)}</h3>${items.length === 0 ? `<p class="muted">None.</p>` : `<ul>${items.map((entry) => `<li><a href="#queue-${esc(entry.queue_item_id)}"><code>${esc(entry.path)}</code></a> ~${esc(entry.estimated_minutes)} min${entry.reason ? ` <span class="muted">(${esc(entry.reason)})</span>` : ""}</li>`).join("")}</ul>`}`;
  return `<p>Budget: ${esc(plan.budget_minutes)} minute(s). Estimates are deterministic approximations; blocker items are budget-exempt.</p>${group("Read", plan.read)}${group("Skim", plan.skim)}${group("Safe to defer", plan.defer)}`;
}

function renderCoverage(model: HumanReviewModel): string {
  const coverage = model.coverage_evidence;
  if (!coverage || coverage.status === "no_report") {
    return `<p class="muted">No coverage evidence: no coverage report was provided. This is different from changed lines being uncovered.</p>`;
  }
  if (coverage.postdates_head === false) {
    return `<p class="muted">The report at <code>${esc(coverage.source_path)}</code> predates the reviewed code: recorded but NOT trusted.</p>`;
  }
  if (coverage.files.length === 0) {
    return `<p class="muted">Report ingested from <code>${esc(coverage.source_path)}</code>, but none of the changed lines are instrumented by it.</p>`;
  }
  return `<ul>${coverage.files
    .map((file) => `<li><code>${esc(file.path)}</code>: ${esc(file.covered_lines)} of ${esc(file.changed_lines)} changed line(s) executed <span class="badge ${esc(file.classification)}">${esc(file.classification)}</span></li>`)
    .join("")}</ul>`;
}

function renderCards(model: HumanReviewModel): string {
  if (model.evidence_cards.length === 0) {
    return `<p class="muted">No evidence cards.</p>`;
  }
  return model.evidence_cards
    .map(
      (card) => `<div class="item" id="card-${esc(card.id)}">
<header><strong>${esc(card.title)}</strong> <span class="badge ${esc(card.priority)}">${esc(card.status)}</span></header>
<p>${esc(card.summary)}</p>
<p class="muted">Why it matters: ${esc(card.why_it_matters)}</p>
<p>Action: ${esc(card.reviewer_action)} <span class="muted">(${esc(card.id)})</span></p>
</div>`
    )
    .join("\n");
}

function renderTrust(model: HumanReviewModel): string {
  const trust = model.trust_audit;
  const section = (label: string, entries: string[]): string =>
    entries.length === 0 ? "" : `<h3>${esc(label)}</h3><ul>${entries.map((entry) => `<li>${entry}</li>`).join("")}</ul>`;
  return [
    `<p class="muted">${esc(trust.confidence_summary)}</p>`,
    section("Verified", trust.verified_facts.map((fact) => esc(fact.summary))),
    section("Claimed (unverified)", trust.claimed_not_verified.map((claim) => `${esc(claim.claim)} <span class="muted">missing: ${esc(claim.missing_evidence)}</span>`)),
    section("Missing evidence", trust.missing_evidence.map((item) => esc(item.summary))),
    section("Invalid evidence", trust.invalid_evidence.map((item) => esc(item.summary)))
  ].join("");
}

// review-surfaces.COVERAGE.6: the cockpit's per-line coverage gutter. Each
// excerpt line gets a glyph + tint keyed by its NEW-side line number: ✖ red
// for an uncovered changed line, ✓ green ONLY for lines the report explicitly
// lists as executed, neutral for not-instrumented lines (comments, type-only —
// never implied-covered). Deleted lines NEVER get a gutter — they have no
// coverage semantics. Without coverage data the excerpt renders exactly as before.
function renderExcerptWithGutter(model: HumanReviewModel, item: ReviewQueueItem, context: HumanRenderContext, redaction?: ExcerptRedactionState): string {
  const excerpt = resolveStructuredExcerpt(context.diff, {
    path: item.path,
    old_path: item.old_path,
    hunk_header: item.hunk_header,
    line_start: item.line_start,
    line_end: item.line_end,
    side: item.anchor_side
  }, undefined, redaction);
  if (!excerpt) {
    return "";
  }
  const coverageSummaryHunk = coverageHunkForAnchor(model, item.path, item.hunk_header);
  // Per-line gutters need per-line data: a legacy (pre-COVERAGE.5) hunk has
  // counts but no line arrays — render NO gutter for it (the summary line
  // still shows the counts) rather than mislabeling lines as not-instrumented.
  const coverageHunk = coverageSummaryHunk?.uncovered_lines !== undefined ? coverageSummaryHunk : undefined;
  const uncovered = new Set(coverageHunk?.uncovered_lines ?? []);
  const covered = new Set(coverageHunk?.covered_line_numbers ?? []);
  const rows = excerpt.lines
    .map((line) => {
      const gutter = gutterFor(line.kind, line.new_line, coverageHunk, uncovered, covered);
      return `<span style="display:block${gutter.tint ? `;background:${gutter.tint}` : ""}"${gutter.label ? ` title="${esc(gutter.label)}"` : ""}>${esc(gutter.glyph)}${esc(line.text)}</span>`;
    })
    .join("");
  const summary = coverageSummaryHunk ? `<p class="muted">Coverage: ${esc(coverageSummaryLine(coverageSummaryHunk))}</p>` : "";
  return `<details><summary>diff excerpt${coverageHunk ? " (with coverage gutter)" : ""}</summary><pre>${esc(excerpt.header)}\n${rows}</pre>${summary}</details>`;
}

function gutterFor(
  kind: string,
  newLine: number | undefined,
  coverageHunk: CoverageEvidenceHunk | undefined,
  uncovered: Set<number>,
  covered: Set<number>
): { glyph: string; tint?: string; label?: string } {
  // Deleted lines and elision markers carry no coverage semantics.
  if (!coverageHunk || kind === "delete" || kind === "elision" || typeof newLine !== "number") {
    return { glyph: "  " };
  }
  if (kind === "add" && uncovered.has(newLine)) {
    return { glyph: "✖ ", tint: "#fde2e2", label: `L${newLine} uncovered` };
  }
  if (kind === "add" && covered.has(newLine)) {
    return { glyph: "✓ ", tint: "#d9f2e3", label: `L${newLine} covered` };
  }
  if (kind === "add") {
    // With a truncated uncovered list, an unlisted-and-not-covered line may be
    // a capped-out uncovered entry — render UNKNOWN, never "not instrumented".
    return coverageHunk.uncovered_truncated
      ? { glyph: "? ", label: "coverage state unknown (uncovered list truncated — see summary)" }
      : { glyph: "· ", label: "not instrumented (no coverage data for this line)" };
  }
  // Context (unchanged) lines: neutral no-data — visually distinct from the
  // blank gutter that marks deletions/elisions (which have NO coverage semantics).
  if (kind === "context") {
    return { glyph: "· ", label: "context line (no coverage data)" };
  }
  return { glyph: "  " };
}

// review-surfaces.TREND.2: the rounds ledger as a compact table — last ~8
// rounds, full ledger in the artifact; partial history renders honestly.
function renderRounds(model: HumanReviewModel): string {
  const rounds = model.rounds ?? [];
  if (rounds.length === 0) {
    return `<p class="muted">No rounds ledger (no prior packet was compared in).</p>`;
  }
  if (rounds.length === 1) {
    return `<p class="muted">First review round — nothing to trend yet.</p>`;
  }
  const shown = rounds.slice(-8);
  // Distinguish genuinely expired earlier rounds from a mere display cap.
  const note =
    rounds[0].round > 1
      ? `<p class="muted">History begins at round ${esc(rounds[0].round)} (earlier rounds expired with their artifacts); full ledger in human_review.json.</p>`
      : shown[0].round > 1
        ? `<p class="muted">Showing the last ${esc(shown.length)} of ${esc(rounds.length)} rounds; full ledger in human_review.json.</p>`
        : "";
  const rows = shown
    .map(
      (entry) =>
        `<tr><td>${esc(entry.round)}</td><td><code>${esc(entry.head_sha.slice(0, 7))}</code></td><td>${esc(entry.new_count)}</td><td>${esc(entry.resolved_count)}</td><td>${esc(entry.regressed_count)}</td><td>${esc(entry.verdict)}</td></tr>`
    )
    .join("");
  return `${note}<table><thead><tr><th>round</th><th>head</th><th>new</th><th>resolved</th><th>regressed</th><th>verdict</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// review-surfaces.RENDER.13: attributed dependency chains as an indented tree
// (supply-chain lens surface). Hidden when no chain resolved.
function renderDependencyChains(model: HumanReviewModel): string {
  const chains = model.dependency_chains ?? [];
  if (chains.length === 0) {
    return "";
  }
  return `<pre>${chains
    .map((chain) =>
      [`${esc(chain.via)} (direct, ${esc(chain.source_path)})`, ...chain.transitives.map((transitive) => `  └─ ${esc(transitive.package)}${transitive.install_scripts ? " ⚠ install scripts" : ""}`)].join("\n")
    )
    .join("\n")}</pre>`;
}

// review-surfaces.EVAL_HARNESS.6: one footer line citing the eval score.
function renderScoreboardFooter(model: HumanReviewModel): string {
  const scoreboard = model.eval_scoreboard;
  if (!scoreboard || scoreboard.classes.length === 0) {
    return "";
  }
  const passed = scoreboard.classes.reduce((sum, entry) => sum + entry.passed, 0);
  const total = scoreboard.classes.reduce((sum, entry) => sum + entry.total, 0);
  return `<p class="muted">Eval scoreboard: ${esc(passed)}/${esc(total)} seeded regression case(s) across ${esc(scoreboard.classes.length)} fact class(es) ranked in the top ${esc(scoreboard.top_n)} (review-surfaces eval harness).</p>`;
}

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
import {
  HumanRenderContext
} from "./render";
import {
  collapseReadingOrderWhy,
  decisionLabel,
  formatQueueLocation,
  rankingReasonsAreDefaultOnly
} from "./review-presentation";
import {
  conversationAnalysisCaveats,
  conversationAnalysisContextRows,
  conversationEvidenceStateLabel,
  conversationInsightBasisLabel,
  conversationInsightCitationGroups,
  conversationReviewPresentation,
  presentableConversationInsights,
  hasConversationReviewValue
} from "./conversation-review-presentation";
import { coverageHunkForAnchor, coverageSummaryLine } from "./coverage-gutter";
// Redact-then-escape: EVERY interpolated value goes through this shared helper
// (lifted to esc.ts so every cockpit fragment uses the same one — RENDER.10).
import { esc } from "./esc";
import { RISK_LENS_METADATA } from "./contract";
import {
  decisionFindingPresentation,
  decisionIntentSourceLabel,
  decisionProjectionHeading,
  EMPTY_DECISION_FINDINGS_TEXT,
  incompleteReviewScopeText
} from "./decision-projection-presentation";
import type { CoverageEvidenceHunk, HumanReviewModel, ReviewQueueItem } from "./contract";
import type { EvidenceRef } from "../evidence/evidence";
import type {
  ConversationAnalysis,
  ReviewerInsight
} from "../contracts/conversation-review";
import { partitionSupportingPreview } from "./primary-surface-policy";

export function renderHumanReviewHtml(model: HumanReviewModel, context: HumanRenderContext = {}): string {
  const lenses = [...new Set(model.review_queue.flatMap((item) => lensesForItem(model, item)))].sort();
  // review-surfaces.PRIVACY.6: render the queue first with a redaction sink so a
  // high-confidence secret in any diff excerpt is observed, not silently dropped.
  const excerptRedaction: ExcerptRedactionState = { blocked: false };
  const renderedQueue = model.review_queue.map((item) =>
    renderQueueItem(model, item, context, excerptRedaction)
  );
  const queueItems = partitionSupportingPreview(renderedQueue);
  const queueHtml = renderedQueue.length === 0
    ? `<p class="muted">No path-backed review queue items.</p>`
    : [
        ...queueItems.preview,
        queueItems.remaining.length > 0
          ? `<details data-supporting-queue><summary>+${esc(queueItems.remaining.length)} supporting queue item(s)</summary>${queueItems.remaining.join("\n")}</details>`
          : ""
      ].filter(Boolean).join("\n");
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>review-surfaces — human review</title>
<style>
:root {
  color-scheme: light dark;
  --bg:#f7f7f4;
  --chrome:#f2f1ed;
  --card:#ebeae5;
  --card-hover:#e6e5e0;
  --fg:#26251e;
  --strong:#050503;
  --muted:#6f6a60;
  --line:#d9d5cf;
  --line-strong:#aaa49a;
  --accent:#f54e00;
  --bad:#cf2d56;
  --warn:#c08532;
  --ok:#1f8a65;
  --info:#3a6a9f;
  --shadow:0 1px 0 rgba(38,37,30,.06);
}
* { box-sizing: border-box; }
[hidden] { display:none !important; }
html { background: var(--bg); }
body { margin:0 auto; max-width: 1120px; padding: 28px 24px 64px; background: var(--bg); color: var(--fg); font: 14px/1.55 "CursorGothic", "CursorGothic Fallback", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
h1 { color: var(--strong); font-size: 26px; font-weight: 400; line-height: 32.5px; margin: 0 0 6px; }
h2 { color: var(--strong); font-size: 18px; font-weight: 700; line-height: 1.25; margin: 30px 0 10px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
h3 { color: var(--strong); font-size: 14px; line-height: 1.35; margin: 18px 0 6px; }
p { margin: .45rem 0; }
ul, ol { margin: .45rem 0 .7rem; padding-left: 1.25rem; }
li { margin: .18rem 0; }
code, pre { font: 12.5px/1.5 "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { background: rgba(38,37,30,.045); border:1px solid rgba(38,37,30,.08); border-radius:4px; padding:.06rem .28rem; color: var(--strong); overflow-wrap:anywhere; }
pre { background: rgba(38,37,30,.045); border:1px solid var(--line); border-radius:4px; padding:.7rem .85rem; overflow-x:auto; color: var(--strong); }
.muted { color: var(--muted); }
strong { color: var(--strong); }
a { color: var(--accent); text-decoration-color: rgba(245,78,0,.35); text-underline-offset: 2px; }
a:hover { text-decoration-color: var(--accent); }
.badge { display:inline-flex; align-items:center; min-height:20px; border-radius:999px; padding: .05rem .5rem; font-size: 11px; font-weight: 500; line-height:1.35; border:1px solid var(--line); background: rgba(247,247,244,.7); color: var(--fg); white-space:nowrap; }
.badge.blocker, .badge.high, .badge.block_before_merge { color:var(--bad); border-color:rgba(207,45,86,.38); background:rgba(207,45,86,.07); }
.badge.medium, .badge.needs_author_clarification, .badge.reviewable_with_attention { color:var(--warn); border-color:rgba(192,133,50,.42); background:rgba(192,133,50,.09); }
.badge.low, .badge.probably_safe, .badge.covered { color:var(--ok); border-color:rgba(31,138,101,.34); background:rgba(31,138,101,.08); }
.badge.contradicted, .badge.degraded { color:var(--bad); border-color:rgba(207,45,86,.38); background:rgba(207,45,86,.07); }
.badge.unverified, .badge.not_assessed { color:var(--warn); border-color:rgba(192,133,50,.42); background:rgba(192,133,50,.09); }
.badge.supported, .badge.analyzed { color:var(--ok); border-color:rgba(31,138,101,.34); background:rgba(31,138,101,.08); }
#strip { background: var(--chrome); border:1px solid var(--line); border-radius:4px; padding: 12px 14px; margin: 12px 0 16px; box-shadow: var(--shadow); }
.item { background: var(--card); border:1px solid var(--line); border-radius:4px; padding: 12px 14px; margin: 10px 0; box-shadow: var(--shadow); }
.item.done { opacity:.62; }
.item header { display:flex; flex-wrap:wrap; gap:7px 8px; align-items:center; }
.item header strong { min-width: min(100%, 280px); flex:1 1 420px; overflow-wrap:anywhere; }
.item header label { margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--muted); white-space:nowrap; }
input[type="checkbox"] { accent-color: var(--accent); }
details { margin:.45rem 0; }
details > summary { cursor:pointer; color:var(--fg); font-size:12px; font-weight:600; }
details > summary:hover { color:var(--accent); }
.filters { display:flex; flex-wrap:wrap; gap:6px; margin:.4rem 0 .65rem; }
.filters button { border:1px solid var(--line); background:var(--chrome); color:var(--fg); border-radius:999px; padding:.25rem .7rem; cursor:pointer; font: inherit; font-size:12px; line-height:1.3; }
.filters button:hover { background:var(--card-hover); border-color:var(--line-strong); }
.filters button.active { border-color: rgba(245,78,0,.75); color: var(--accent); background:#f3ede6; box-shadow: inset 0 0 0 1px rgba(245,78,0,.12); }
.strip-bar, .progress-track { border:1px solid var(--line); border-radius:4px; overflow:hidden; margin:.45rem 0; background:rgba(247,247,244,.72); }
.strip-bar { display:flex; min-height:24px; }
.budget-segment { display:inline-block; padding:.2rem .45rem; overflow:hidden; white-space:nowrap; font-size:12px; color:var(--fg); border-right:1px solid rgba(38,37,30,.08); }
.budget-segment.read { background:rgba(31,138,101,.12); }
.budget-segment.skim { background:rgba(192,133,50,.14); }
.budget-segment.defer { background:rgba(38,37,30,.06); }
.progress-track { height:10px; }
#progress-bar { height:100%; width:0; background:var(--accent); }
table { width:100%; border-collapse:collapse; margin:.6rem 0; font-size:12px; }
th, td { border-bottom:1px solid var(--line); padding:.35rem .45rem; text-align:left; vertical-align:top; }
th { color:var(--muted); font-weight:600; }
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#141612;
    --chrome:#1b1e19;
    --card:#22251f;
    --card-hover:#2a2e27;
    --fg:#d6d9d1;
    --strong:#f4f5f1;
    --muted:#a9ada3;
    --line:#373c34;
    --line-strong:#60675c;
    --accent:#ff7137;
    --bad:#ff668c;
    --warn:#e0a95a;
    --ok:#55c49a;
    --info:#78a9df;
    --shadow:0 1px 0 rgba(0,0,0,.28);
  }
  code, pre { background:rgba(255,255,255,.045); border-color:rgba(255,255,255,.08); }
  .badge { background:rgba(20,22,18,.72); }
  .filters button.active { background:#302720; }
  .strip-bar, .progress-track { background:rgba(20,22,18,.72); }
}
@media print { .item header label { display:none; } details > * { display:block; } }
</style>
</head>
<body>
<h1>Human review</h1>
<p class="muted">Generated from <code>${esc(model.generated_from.packet_path)}</code> · <code>${esc(model.generated_from.base_ref)}</code> → <code>${esc(model.generated_from.head_ref)}</code> @ <code>${esc(model.generated_from.head_sha)}</code>${model.generated_from.uncommitted_files > 0 ? ` · includes ${model.generated_from.uncommitted_files} uncommitted file(s) (working tree)` : ""}</p>
${incompleteReviewScopeText(model.generated_from.omitted_untracked_files ?? 0) ? `<p class="callout"><strong>${esc(incompleteReviewScopeText(model.generated_from.omitted_untracked_files ?? 0)!)}</strong></p>` : ""}

<h2 id="verdict">Verdict</h2>
<p><span class="badge ${esc(model.verdict.decision)}">${esc(decisionLabel(model.verdict.decision))}</span> <span class="muted">confidence: ${esc(model.verdict.confidence)}</span></p>
${renderDecisionProjection(model)}

${renderPrimaryQuestions(model)}

<h2 id="required-checks">Required checks</h2>
${renderRequiredChecks(model)}

<h2 id="trust-summary">Trust summary</h2>
${renderTrustSummary(model)}

<h2 id="queue">Supporting review queue</h2>
${queueHtml}

${renderHeaderStrip(model, lenses)}
${hasConversationReviewValue(model) ? renderConversationInsights(model) : ""}
<h2 id="reading-order">Reading order</h2>
${renderReadingOrder(model)}

${renderNarrative(model)}

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

<h2 id="methodology">Agent workflow audit</h2>
${renderMethodologyAudit(model)}

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
  // Lens filters keep the supporting queue navigable without introducing a
  // second structural surface that competes with the reading order.
  var activeLens = null;
  function applyFilters() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-lenses]"), function (item) {
      var lensOk = !activeLens || activeLens === "all" || (" " + item.getAttribute("data-lenses") + " ").indexOf(" " + activeLens + " ") >= 0;
      item.style.display = lensOk ? "" : "none";
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-supporting-queue]"), function (details) {
      var visibleMatch = false;
      Array.prototype.forEach.call(details.querySelectorAll("[data-lenses]"), function (item) {
        if (item.style.display !== "none") { visibleMatch = true; }
      });
      if (activeLens && visibleMatch) {
        if (!details.open) { details.setAttribute("data-filter-opened", "true"); }
        details.open = true;
      } else if (details.getAttribute("data-filter-opened") === "true") {
        details.open = false;
        details.removeAttribute("data-filter-opened");
      }
    });
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
})();
</script>
</body>
</html>
`;
  // review-surfaces.PRIVACY.6: the persisted cockpit held BLOCKED material if any
  // diff excerpt raised the block signal, OR any esc()'d model field (summary,
  // narrative, reasons, and cards) was redacted to a high-confidence
  // marker. Surface one deterministic, greppable notice in either case.
  const blocked = excerptRedaction.blocked || containsBlockedRedaction(body);
  if (!blocked) {
    return body;
  }
  const notice = `<p class="muted" data-excerpt-redaction="blocked">⚠ A high-confidence secret was redacted from this review.</p>`;
  return body.replace("<h1>Human review</h1>", `<h1>Human review</h1>\n${notice}`);
}

function renderDecisionProjection(model: HumanReviewModel): string {
  const projection = model.decision_projection;
  const source = decisionIntentSourceLabel(projection.active_intent.source);
  const findings = projection.findings.length === 0
    ? `<p class="muted">${esc(EMPTY_DECISION_FINDINGS_TEXT)}</p>`
    : `<ol>${projection.findings.map((finding) => {
      const row = decisionFindingPresentation(finding);
      const evidenceHtml = row.evidence.length > 0
        ? `<br><span class="muted">Evidence: ${row.evidence.map((value) => `<code>${esc(value)}</code>`).join(", ")}</span>`
        : "";
      const reason = row.reason ? ` — ${esc(row.reason)}` : "";
      return `<li><strong>${esc(row.title)}</strong>${row.path ? ` <code>${esc(row.path)}</code>` : ""}${reason}<br><span class="muted">Review: ${esc(row.reviewerAction)}</span>${evidenceHtml}</li>`;
    }).join("")}</ol>`;
  const decisionLabel = decisionProjectionHeading(projection.findings.length);
  return `<h2 id="change-purpose">Change purpose</h2><p>${esc(projection.active_intent.summary)}</p><p class="muted">${esc(source)}.</p><h2 id="approval-decisions">${esc(decisionLabel)}</h2>${findings}`;
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

function renderConversationInsights(model: HumanReviewModel): string {
  const analysis = model.conversation_analysis;
  const insights = presentableConversationInsights(analysis, model.review_insights);
  const presentation = conversationReviewPresentation(analysis);
  const caveats = conversationAnalysisCaveats(analysis);
  const cards = insights.length === 0
    ? `<p class="muted">${esc(presentation.emptyMessage)}</p>`
    : insights.map((insight) => {
      const citations = conversationInsightCitationsHtml(insight);
      return `<article class="item insight" id="insight-${esc(insight.id)}">
<header><strong>${esc(insight.title)}</strong><span class="badge ${esc(insight.evidence_state)}">${esc(conversationEvidenceStateLabel(insight.evidence_state))}</span><span class="badge ${esc(insight.priority)}">${esc(insight.priority)}</span></header>
<p><strong>What changed:</strong> ${esc(insight.summary)}</p>
<p><strong>Why it matters:</strong> ${esc(insight.why_it_matters)}</p>
<p><strong>Review:</strong> ${esc(insight.reviewer_action)}</p>
<p class="muted"><strong>Grounding:</strong> ${esc(conversationInsightBasisLabel(insight.basis))}</p>
${citations ? `<p class="muted">Evidence: ${citations}</p>` : ""}
</article>`;
    }).join("\n");
  return `<h2 id="conversation-insights">Conversation-aware insights</h2>
<p><span class="badge ${esc(presentation.status)}">${esc(presentation.statusLabel)}</span> ${presentation.summaryLabel ? `${esc(presentation.summaryLabel)}: ` : ""}${esc(presentation.summary)}</p>
${renderConversationContextHtml(analysis)}
${caveats.length > 0 ? `<p class="muted"><strong>Caveat:</strong> ${esc(caveats.join(" "))}</p>` : ""}
${cards}`;
}

function renderConversationContextHtml(analysis: ConversationAnalysis): string {
  const rows = conversationAnalysisContextRows(analysis).map((row) =>
    `<li><strong>${esc(row.label)}:</strong> ${row.items.map((item) =>
      `${esc(item.text)} (${compactHtmlCitations(item.eventIds)})`
    ).join("; ")}</li>`
  );
  return rows.length > 0 ? `<ul class="compact">${rows.join("")}</ul>` : "";
}

function conversationInsightCitationsHtml(insight: ReviewerInsight): string {
  return conversationInsightCitationGroups(insight)
    .map((group) => `${group.label} ${compactHtmlCitations(group.values)}`)
    .join("; ");
}

function compactHtmlCitations(values: string[]): string {
  const shown = values.slice(0, 3).map((value) => `<code>${esc(value)}</code>`).join(", ");
  const omitted = values.length - Math.min(values.length, 3);
  return shown ? `${shown}${omitted > 0 ? ` (+${esc(omitted)})` : ""}` : "";
}

// review-surfaces.RENDER.12: the at-a-glance supporting-control strip, rendered
// purely from existing model fields — lens chips with counts that ARE the filter
// buttons, the review_plan read/skim/defer cut as a stacked CSS bar with minutes,
// and a progress bar fed by the persisted checkbox state. Every chip
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
    const segment = (label: string, value: number, className: string): string =>
      value <= 0
        ? ""
        : `<span class="budget-segment ${className}" style="width:${Math.max(6, Math.round((value / total) * 100))}%">${esc(label)} ${esc(value)}m</span>`;
    budgetBar = `<div class="strip-bar">${segment("read", read, "read")}${segment("skim", skim, "skim")}${segment("defer", defer, "defer")}</div>`;
  }

  const progress =
    model.review_queue.length > 0
      ? `<div class="progress-track"><div id="progress-bar"></div></div><p class="muted" id="progress-label">0 of ${esc(model.review_queue.length)} reviewed</p>`
      : "";
  const contents = `${chips}${budgetBar}${progress}`;
  return contents ? `<div id="strip">${contents}</div>` : "";
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
    return "";
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
  return `<h2 id="narrative">Change narrative</h2><p class="muted">✓ anchored means the citations were validated; it does not independently prove the prose. ~ claimed has missing or invalid anchors.</p><ul>${claims}</ul>`;
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

function renderPrimaryQuestions(model: HumanReviewModel): string {
  const questions = model.questions.filter((question) => question.severity !== "blocking");
  if (questions.length === 0) return "";
  const renderQuestion = (question: HumanReviewModel["questions"][number]): string =>
    `<li><span class="badge ${esc(question.severity)}">${esc(question.severity)}</span> ${esc(question.question)} <span class="muted">(${esc(question.id)}; evidence: ${evidenceRefsHtml(question.evidence)})</span></li>`;
  const questionItems = partitionSupportingPreview(questions);
  const primary = questionItems.preview.map(renderQuestion).join("");
  const supporting = questionItems.remaining;
  return `<h2 id="questions">Additional author questions</h2><ul>${primary}</ul>${supporting.length > 0 ? `<details><summary>+${esc(supporting.length)} supporting question(s)</summary><ul>${supporting.map(renderQuestion).join("")}</ul></details>` : ""}`;
}

function renderRequiredChecks(model: HumanReviewModel): string {
  const required = model.test_plan.filter((item) => item.priority === "required");
  if (required.length === 0) return `<p class="muted">No required checks were generated.</p>`;
  return `<p>${esc(required.length)} required check(s). See <a href="test_plan.md"><code>test_plan.md</code></a> for exact commands and expected results.</p>`;
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

function renderTrustSummary(model: HumanReviewModel): string {
  const trust = model.trust_audit;
  // The generated confidence summary usually restates these same counts. Keep
  // the first-pass scan to one line; the full confidence prose remains in the
  // later Trust audit section.
  return `<p>${esc(trust.verified_facts.length)} verified fact(s); ${esc(trust.claimed_not_verified.length)} unverified claim(s); ${esc(trust.missing_evidence.length)} missing-evidence item(s); ${esc(trust.invalid_evidence.length)} invalid-evidence item(s).</p>`;
}

// review-surfaces.METHODOLOGY.7/.8 (Phase 4): the agent-workflow audit card —
// considered alternatives (4a), research/context (4b), and the grounded item-4
// workflow findings (the LLM proposals AND the deterministic D6 cross-reference
// signals). A corroborated (non-advisory) finding is badged so the cockpit shows
// the promotion, mirroring the question gating.
function renderMethodologyAudit(model: HumanReviewModel): string {
  const audit = model.methodology_audit;
  const list = (label: string, entries: string[]): string =>
    entries.length === 0 ? "" : `<h3>${esc(label)}</h3><ul>${entries.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul>`;
  const findings =
    audit.workflow_findings.length === 0
      ? ""
      : `<h3>Workflow findings</h3><ul>${audit.workflow_findings
          .map(
            (finding) =>
              `<li><span class="badge ${finding.advisory ? "low" : esc(finding.severity)}">${finding.advisory ? "advisory" : "corroborated"}</span> <span class="muted">${esc(finding.signal_kind.replace(/_/g, " "))}</span>: ${esc(finding.summary)} <span class="muted">[${evidenceRefsHtml(finding.evidence)}]</span></li>`
          )
          .join("")}</ul>`;
  // D2 (Codex P2): show the RIGHT caveat per audit-completeness flag — keyword
  // fallback vs no conversation vs a PARTIAL (truncated) audit — so a truncated run
  // is not mislabeled "no LLM provider" and keyword picks are not read as an audit.
  const NOTE: Record<string, string> = {
    methodology_analysis_degraded: "Deep audit not run (no LLM provider); the items below are deterministic keyword picks, not a conversation audit.",
    conversation_log_missing: "No conversation log was available — this audit is derived only from local files and command context.",
    conversation_truncated: "Audit was partial — only a salience-ranked slice of a long conversation was analyzed."
  };
  const notes = audit.quality_flags.map((flag) => NOTE[flag]).filter((note): note is string => Boolean(note));
  const degradedNote = notes.length === 0 ? "" : `<p class="muted"><em>${notes.map((note) => esc(note)).join(" ")}</em></p>`;
  const body = [
    degradedNote,
    list("Considered alternatives", audit.considered),
    list("Research / context gathered", audit.research),
    findings
  ].join("");
  return body === "" ? `<p class="muted">No agent-workflow audit content (no conversation analyzed, or nothing flagged).</p>` : body;
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
  const coverageHunk = coverageSummaryHunk;
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
  const rounds = model.rounds;
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

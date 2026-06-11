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
import { redactSecrets } from "../privacy/secrets";
import { renderHunkExcerpt } from "./hunk-excerpt";
import { decisionLabel, formatQueueLocation, HumanRenderContext } from "./render";
import { RISK_LENS_METADATA } from "./contract";
import type { HumanReviewModel, ReviewQueueItem } from "./contract";
import type { EvidenceRef } from "../evidence/evidence";

// Redact first (multi-line secrets must be matched before any slicing), then
// HTML-escape. EVERY interpolated value goes through this helper.
function esc(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? "" : String(value);
  return redactSecrets(text).text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderHumanReviewHtml(model: HumanReviewModel, context: HumanRenderContext = {}): string {
  const lenses = [...new Set(model.review_queue.flatMap((item) => lensesForItem(model, item)))].sort();
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
@media print { .filters, .item header label { display:none; } details > * { display:block; } }
</style>
</head>
<body>
<h1>Human review</h1>
<p class="muted">Generated from <code>${esc(model.generated_from.packet_path)}</code> · <code>${esc(model.generated_from.base_ref)}</code> → <code>${esc(model.generated_from.head_ref)}</code> @ <code>${esc(model.generated_from.head_sha)}</code></p>

<h2 id="verdict">Verdict</h2>
<p><span class="badge ${esc(model.verdict.decision)}">${esc(decisionLabel(model.verdict.decision))}</span> <span class="muted">confidence: ${esc(model.verdict.confidence)}</span></p>
<p>${esc(model.summary)}</p>
${renderNarrative(model)}
${renderBlockers(model)}

<h2 id="reading-order">Reading order</h2>
${renderReadingOrder(model)}

<h2 id="queue">Review queue</h2>
${renderLensFilters(lenses)}
${model.review_queue.length === 0 ? `<p class="muted">No path-backed review queue items.</p>` : model.review_queue.map((item) => renderQueueItem(model, item, context)).join("\n")}

<h2 id="plan">Review plan</h2>
${renderPlan(model)}

<h2 id="coverage">Coverage evidence</h2>
${renderCoverage(model)}

<h2 id="cards">Evidence cards</h2>
${renderCards(model)}

<h2 id="trust">Trust audit</h2>
${renderTrust(model)}

<h2 id="questions">Questions for the author</h2>
${model.questions.length === 0 ? `<p class="muted">No reviewer questions generated.</p>` : `<ul>${model.questions.map((question) => `<li><span class="badge ${esc(question.severity)}">${esc(question.severity)}</span> ${esc(question.question)} <span class="muted">(${esc(question.id)})</span></li>`).join("")}</ul>`}

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
  var buttons = document.querySelectorAll("[data-lens-filter]");
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener("click", function () {
      var lens = button.getAttribute("data-lens-filter");
      var active = button.classList.toggle("active");
      Array.prototype.forEach.call(buttons, function (other) { if (other !== button) { other.classList.remove("active"); } });
      Array.prototype.forEach.call(document.querySelectorAll("[data-lenses]"), function (item) {
        var show = !active || lens === "all" || (" " + item.getAttribute("data-lenses") + " ").indexOf(" " + lens + " ") >= 0;
        item.style.display = show ? "" : "none";
      });
    });
  });
})();
</script>
</body>
</html>
`;
  return body;
}

function lensesForItem(model: HumanReviewModel, item: ReviewQueueItem): string[] {
  return model.risk_lens_findings
    .filter((finding) => finding.risk_ids.some((id) => item.risk_ids.includes(id)) || finding.paths.includes(item.path))
    .map((finding) => finding.lens);
}

function renderLensFilters(lenses: string[]): string {
  if (lenses.length === 0) {
    return "";
  }
  const buttons = ["all", ...lenses]
    .map((lens) => `<button data-lens-filter="${esc(lens)}">${esc(lens === "all" ? "All lenses" : RISK_LENS_METADATA[lens as keyof typeof RISK_LENS_METADATA]?.label ?? lens)}</button>`)
    .join("");
  return `<p class="filters">${buttons}</p>`;
}

function renderQueueItem(model: HumanReviewModel, item: ReviewQueueItem, context: HumanRenderContext): string {
  const excerpt = renderHunkExcerpt(context.diff, {
    path: item.path,
    old_path: item.old_path,
    hunk_header: item.hunk_header,
    line_start: item.line_start,
    line_end: item.line_end,
    side: item.anchor_side
  });
  const excerptHtml = excerpt
    ? `<details><summary>diff excerpt</summary><pre>${esc(excerpt.split("\n").slice(1, -1).join("\n"))}</pre></details>`
    : "";
  const cardLinks = model.evidence_cards
    .filter((card) => card.risk_ids.some((id) => item.risk_ids.includes(id)))
    .map((card) => `<a href="#card-${esc(card.id)}">${esc(card.id)}</a>`)
    .join(" ");
  const lenses = lensesForItem(model, item);
  return `<div class="item" data-lenses="${esc(lenses.join(" "))}" id="queue-${esc(item.id)}">
<header><strong>${esc(item.rank)}. <code>${esc(formatQueueLocation(item))}</code></strong> <span class="badge ${esc(item.priority)}">${esc(item.priority)}</span><label><input type="checkbox" data-queue-check="${esc(item.id)}"> reviewed</label></header>
<p>${esc(item.reason)}</p>
<p class="muted">Why ranked here: ${esc(item.ranking_reasons.join("; "))}</p>
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
    .map((ref) => `<code>${esc(ref.path ?? ref.acai_id ?? ref.kind)}</code>`)
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
  return legs
    .map((leg) => {
      const steps = leg.steps
        .map((step) => {
          stepNumber += 1;
          const refs = step.queue_refs.length > 0 ? ` <span class="muted">(queue: ${step.queue_refs.map((ref) => esc(ref)).join(", ")})</span>` : "";
          return `<li value="${stepNumber}"><code>${esc(step.path)}</code> — ${esc(step.why)}${refs}</li>`;
        })
        .join("");
      return `<h3>${esc(leg.title)}</h3><ol>${steps}</ol>`;
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

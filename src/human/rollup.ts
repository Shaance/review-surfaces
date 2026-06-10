// review-surfaces.HUMAN_REVIEW.19 (rollup deduplication) and
// review-surfaces.HUMAN_REVIEW.21 (reviewer-language lint) renderer helpers.
//
// These operate at the RENDER layer only. The human_review.json model and the
// standalone artifacts (test_plan.md, evidence_cards.md, ...) keep full per-item
// detail; only the default human_review.md surface aggregates near-identical
// templated findings into a single rollup so a reviewer is not shown the same
// sentence once per requirement ID.

// An Acai ID: an optional lowercase dotted prefix (e.g. `review-surfaces.`)
// followed by an UPPER_SNAKE group and a numeric index, e.g.
// `review-surfaces.HUMAN_TRUST.1` or the bare `BOOTSTRAP.4`.
const ACID_RE = /(?:[a-z][a-z0-9-]*\.)?[A-Z][A-Z0-9_]*\.\d+/g;

// A printable sentinel that marks where an ACID was removed from a template.
// U+FFFC (OBJECT REPLACEMENT CHARACTER) never appears in reviewer prose, so it
// round-trips cleanly through split/join without colliding with real text — and
// keeps this file plain text (a literal NUL byte would make git treat it as
// binary).
const ACID_PLACEHOLDER = "￼ACID￼";

export function extractAcids(text: string): string[] {
  const matches = text.match(ACID_RE);
  return matches ? [...matches] : [];
}

// Replace every Acai ID in `text` with a stable placeholder and collapse runs of
// whitespace so two sentences that differ only by their ACID normalize equal.
export function normalizeAcidTemplate(text: string): string {
  return text.replace(ACID_RE, ACID_PLACEHOLDER).replace(/\s+/g, " ").trim();
}

export interface RollupGroup<T> {
  /** All items that share the normalized template, in input order. */
  items: T[];
  /** The first item, used as the rendering representative. */
  representative: T;
  /** Sorted, de-duplicated Acai IDs contributed across the group. */
  acids: string[];
}

// Group `items` by an ACID-normalized template key, preserving first-seen order.
// `acidsOf` returns the Acai IDs an item contributes to its group's rollup list.
export function rollupBy<T>(
  items: T[],
  templateKey: (item: T) => string,
  acidsOf: (item: T) => string[]
): RollupGroup<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, { items: T[]; acids: Set<string> }>();
  for (const item of items) {
    const key = templateKey(item);
    let group = byKey.get(key);
    if (!group) {
      group = { items: [], acids: new Set<string>() };
      byKey.set(key, group);
      order.push(key);
    }
    group.items.push(item);
    for (const acid of acidsOf(item)) {
      group.acids.add(acid);
    }
  }
  return order.map((key) => {
    const group = byKey.get(key)!;
    return {
      items: group.items,
      representative: group.items[0],
      acids: [...group.acids].sort()
    };
  });
}

// Fill the ACID placeholders left by `normalizeAcidTemplate` with a count-aware
// phrase so a rolled-up sentence reads naturally: the single ACID when there is
// one, or "the listed requirements" when several were merged.
export function fillAcidTemplate(template: string, acids: string[]): string {
  const replacement = acids.length === 1 ? acids[0] : "the listed requirements";
  // Replace EVERY placeholder with the phrase, preserving the prose between them
  // so a sentence that cites multiple requirements (e.g. "Compare A to B") stays
  // readable ("Compare the listed requirements to the listed requirements")
  // instead of dropping the text after the first placeholder.
  return template.split(ACID_PLACEHOLDER).join(replacement).replace(/\s+/g, " ").trim();
}

// review-surfaces.HUMAN_REVIEW.21 lint: detect a reviewer-facing line whose
// subject is an internal identifier (an all-caps dashed id like RISK-002 /
// CARD-001 / READY-MISSING-EVIDENCE, or an Acai ID) rather than the changed
// file, observable behavior, or reviewer action. Markdown list/heading/quote
// markers are stripped before the check so `- CARD-001: …` is still flagged.
const LIST_MARKER_RE = /^\s*(?:[-*>]\s+|#{1,6}\s+|\d+\.\s+)/;
const INTERNAL_ID_LEAD_RE = /^(?:[A-Z][A-Z0-9_]*(?:-[A-Z0-9_]+)+|[A-Z][A-Z0-9_]*-\d+|(?:[a-z][a-z0-9-]*\.)?[A-Z][A-Z0-9_]*\.\d+)\b/;

export function leadsWithInternalId(line: string): boolean {
  const stripped = line.replace(LIST_MARKER_RE, "");
  if (stripped.length === 0) {
    return false;
  }
  return INTERNAL_ID_LEAD_RE.test(stripped);
}

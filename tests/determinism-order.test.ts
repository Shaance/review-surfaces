import test from "node:test";
import assert from "node:assert/strict";
import { compareStrings } from "../src/core/compare";

// Locale ordering would interleave these differently (e.g. localeCompare puts
// '_' '-' '.' before letters and groups case-insensitively); code-unit order is
// fixed: ASCII punctuation by code point, ALL uppercase before ALL lowercase,
// non-ASCII last. This pins compareStrings to that fixed order so a regression
// back to locale ordering is caught, proving artifact ordering is locale-invariant.
test("compareStrings is code-unit stable for punctuation, case, and non-ASCII", () => {
  const input = ["b_a", "b-a", "b.a", "bA", "ba", "Zebra", "apple", "_lead", "-lead", ".lead", "café", "cafe", "File", "file"];
  const sorted = [...input].sort(compareStrings);
  // EXACT expected order (empirically verified via `a<b?-1:a>b?1:0`):
  assert.deepEqual(sorted, [
    "-lead", ".lead", "File", "Zebra", "_lead", "apple",
    "b-a", "b.a", "bA", "b_a", "ba", "cafe", "café", "file"
  ]);
});

test("compareStrings returns the localeCompare-compatible -1/0/1 contract", () => {
  assert.equal(compareStrings("a", "b"), -1);
  assert.equal(compareStrings("b", "a"), 1);
  assert.equal(compareStrings("a", "a"), 0);
});

test("compareStrings composes with || in multi-key sorts (uppercase before lowercase)", () => {
  // A code-unit selector sort orders objects by a string key, code-unit stable:
  // uppercase 'B'/'Z' sort before lowercase 'a' (the opposite of locale order).
  const rows = [{ p: "src/Z.ts" }, { p: "src/a.ts" }, { p: "src/B.ts" }];
  const ordered = [...rows].sort((left, right) => compareStrings(left.p, right.p)).map((r) => r.p);
  assert.deepEqual(ordered, ["src/B.ts", "src/Z.ts", "src/a.ts"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { globToRegExp } from "../src/core/glob";

// F-SRC adds a stderr warning to globToRegExp for unsupported glob
// metacharacters ({ } ? ! [ ]), which glob.ts only escapes literally rather than
// expanding. The warning is informational (stderr only, never an artifact) and
// de-duped per distinct pattern. These tests capture process.stderr.write to
// assert the warning behavior without coupling to the exact wording — they check
// that the offending pattern token appears, that supported wildcards stay silent
// and still match, and that the de-dupe fires once per pattern.

// Override process.stderr.write for the duration of `fn`, collecting every
// written chunk, and always restore it afterward (even on throw).
function captureStderr(fn: () => void): string[] {
  const original = process.stderr.write.bind(process.stderr);
  const writes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any): boolean => {
    writes.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = original;
  }
  return writes;
}

test("globToRegExp on a supported * / ** pattern writes nothing to stderr and still matches", () => {
  let regex: RegExp | undefined;
  const writes = captureStderr(() => {
    regex = globToRegExp("src/**/*.ts");
  });
  assert.equal(writes.join(""), "", "supported wildcards must not warn");
  assert.ok(regex, "a regex is returned");
  assert.equal(regex!.test("src/a/b.ts"), true, "the ** pattern still matches a nested path");
});

// warnedGlobPatterns in glob.ts is a process-level Set that persists for the
// whole test run, so each glob-warn assertion MUST use a process-unique pattern
// string: a pattern already warned by another test (or an earlier call) is
// suppressed and would make a "must warn" assertion see 0. Every pattern below
// carries a unique sentinel segment to stay independent of test order.
test("globToRegExp warns on each unsupported metacharacter", () => {
  for (const pattern of [
    "src/__gw_brace__/{a,b}/x.ts",
    "src/__gw_qmark__/a?.ts",
    "src/__gw_bang__/!a.ts",
    "src/__gw_class__/[ab].ts"
  ]) {
    const writes = captureStderr(() => {
      globToRegExp(pattern);
    });
    const text = writes.join("");
    assert.notEqual(text, "", `pattern ${pattern} must warn to stderr`);
    assert.ok(text.includes(pattern), `the warning must name the offending pattern ${pattern}, got: ${text}`);
  }
});

test("the unsupported-metacharacter warning de-dupes per distinct pattern", () => {
  // The SAME brace pattern twice must warn only once (warnedGlobPatterns set).
  // The sentinel segment guarantees no other test primed this pattern first.
  const pattern = "src/__gw_dedupe_sentinel__/{x,y}/z.ts";
  const writes = captureStderr(() => {
    globToRegExp(pattern);
    globToRegExp(pattern);
  });
  const occurrences = writes.join("").split(pattern).length - 1;
  assert.equal(occurrences, 1, "the same pattern must warn exactly once, not per call");
});

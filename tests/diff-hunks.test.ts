import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { StructuredDiffFile } from "../src/pr/contract";

function fileByPath(files: StructuredDiffFile[], path: string): StructuredDiffFile {
  const found = files.find((file) => file.path === path);
  assert.ok(found, `expected a file with path ${path}`);
  return found;
}

test("parseStructuredDiff parses a multi-file add/modify/delete/rename diff", () => {
  // Inline unified-diff fixture covering all four statuses in source order:
  //   1. modify  src/keep.ts
  //   2. add     src/added.ts          (--- a side is /dev/null, new file mode)
  //   3. delete  src/removed.ts        (+++ b side is /dev/null, deleted file)
  //   4. rename  src/old.ts -> src/new.ts (rename from/to, a/ != b/)
  const diff = [
    "diff --git a/src/keep.ts b/src/keep.ts",
    "index 1111111..2222222 100644",
    "--- a/src/keep.ts",
    "+++ b/src/keep.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 20;",
    "+const c = 30;",
    " const d = 4;",
    "diff --git a/src/added.ts b/src/added.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,2 @@",
    "+export const x = 1;",
    "+export const y = 2;",
    "diff --git a/src/removed.ts b/src/removed.ts",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/src/removed.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export const gone = 1;",
    "-export const alsoGone = 2;",
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 95%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "index 5555555..6666666 100644",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -10,3 +10,3 @@",
    " keep one",
    "-old line",
    "+new line",
    " keep two",
    ""
  ].join("\n");

  const result = parseStructuredDiff(diff);

  // Deterministic order = source order.
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["src/keep.ts", "src/added.ts", "src/removed.ts", "src/new.ts"]
  );

  // --- Modify --------------------------------------------------------------
  const keep = fileByPath(result.files, "src/keep.ts");
  assert.equal(keep.status, "modified");
  assert.equal(keep.old_path, undefined);
  assert.equal(keep.hunks.length, 1);
  const keepHunk = keep.hunks[0];
  assert.deepEqual(
    { os: keepHunk.old_start, ol: keepHunk.old_lines, ns: keepHunk.new_start, nl: keepHunk.new_lines },
    { os: 1, ol: 3, ns: 1, nl: 4 }
  );
  assert.deepEqual(
    keepHunk.lines.map((line) => ({ kind: line.kind, text: line.text, o: line.old_line, n: line.new_line })),
    [
      { kind: "context", text: "const a = 1;", o: 1, n: 1 },
      { kind: "delete", text: "const b = 2;", o: 2, n: undefined },
      { kind: "add", text: "const b = 20;", o: undefined, n: 2 },
      { kind: "add", text: "const c = 30;", o: undefined, n: 3 },
      { kind: "context", text: "const d = 4;", o: 3, n: 4 }
    ]
  );

  // --- Add -----------------------------------------------------------------
  const added = fileByPath(result.files, "src/added.ts");
  assert.equal(added.status, "A");
  assert.equal(added.old_path, undefined);
  assert.deepEqual(
    added.hunks[0].lines.map((line) => ({ kind: line.kind, n: line.new_line, o: line.old_line })),
    [
      { kind: "add", n: 1, o: undefined },
      { kind: "add", n: 2, o: undefined }
    ]
  );
  assert.equal(added.hunks[0].old_start, 0);
  assert.equal(added.hunks[0].old_lines, 0);

  // --- Delete --------------------------------------------------------------
  const removed = fileByPath(result.files, "src/removed.ts");
  assert.equal(removed.status, "D");
  assert.equal(removed.old_path, undefined);
  assert.deepEqual(
    removed.hunks[0].lines.map((line) => ({ kind: line.kind, o: line.old_line, n: line.new_line })),
    [
      { kind: "delete", o: 1, n: undefined },
      { kind: "delete", o: 2, n: undefined }
    ]
  );

  // --- Rename --------------------------------------------------------------
  const renamed = fileByPath(result.files, "src/new.ts");
  assert.equal(renamed.status, "R");
  assert.equal(renamed.old_path, "src/old.ts");
  assert.equal(renamed.hunks[0].old_start, 10);
  assert.equal(renamed.hunks[0].new_start, 10);
  assert.deepEqual(
    renamed.hunks[0].lines.map((line) => line.kind),
    ["context", "delete", "add", "context"]
  );
});

test("parseStructuredDiff defaults omitted hunk line counts to 1", () => {
  // `@@ -5 +5 @@` has no `,N` count on either side => both default to 1.
  const diff = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -5 +5 @@",
    "-old single",
    "+new single",
    ""
  ].join("\n");

  const result = parseStructuredDiff(diff);
  const hunk = fileByPath(result.files, "file.txt").hunks[0];
  assert.deepEqual(
    { os: hunk.old_start, ol: hunk.old_lines, ns: hunk.new_start, nl: hunk.new_lines },
    { os: 5, ol: 1, ns: 5, nl: 1 }
  );
});

test("parseStructuredDiff ignores the no-newline marker without emitting a line", () => {
  const diff = [
    "diff --git a/eof.txt b/eof.txt",
    "--- a/eof.txt",
    "+++ b/eof.txt",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    ""
  ].join("\n");

  const result = parseStructuredDiff(diff);
  const hunk = fileByPath(result.files, "eof.txt").hunks[0];
  assert.deepEqual(
    hunk.lines.map((line) => ({ kind: line.kind, text: line.text })),
    [
      { kind: "delete", text: "old" },
      { kind: "add", text: "new" }
    ]
  );
});

test("parseStructuredDiff degrades a binary section to a hunk-less file", () => {
  const diff = [
    "diff --git a/text.txt b/text.txt",
    "--- a/text.txt",
    "+++ b/text.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
    ""
  ].join("\n");

  const result = parseStructuredDiff(diff);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["text.txt", "logo.png"]
  );
  const binary = fileByPath(result.files, "logo.png");
  assert.equal(binary.status, "modified");
  assert.deepEqual(binary.hunks, []);
});

test("parseStructuredDiff treats an added binary file as status A with no hunks", () => {
  const diff = [
    "diff --git a/asset.bin b/asset.bin",
    "new file mode 100644",
    "index 0000000..abcdef0",
    "Binary files /dev/null and b/asset.bin differ",
    ""
  ].join("\n");

  const result = parseStructuredDiff(diff);
  const file = fileByPath(result.files, "asset.bin");
  assert.equal(file.status, "A");
  assert.deepEqual(file.hunks, []);
});

test("parseStructuredDiff is robust to malformed and empty input (never throws)", () => {
  // Empty / non-diff text yields an empty file list, not an exception.
  assert.deepEqual(parseStructuredDiff("").files, []);
  assert.deepEqual(parseStructuredDiff("not a diff at all\njust text\n").files, []);

  // A section with a malformed hunk header keeps the file but drops the bad
  // hunk; a following well-formed section still parses.
  const diff = [
    "diff --git a/broken.ts b/broken.ts",
    "--- a/broken.ts",
    "+++ b/broken.ts",
    "@@ this is not a valid hunk header @@",
    "+orphan body line that should be ignored",
    "diff --git a/good.ts b/good.ts",
    "--- a/good.ts",
    "+++ b/good.ts",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    ""
  ].join("\n");

  assert.doesNotThrow(() => parseStructuredDiff(diff));
  const files = parseStructuredDiff(diff).files;
  const broken = fileByPath(files, "broken.ts");
  assert.deepEqual(broken.hunks, [], "malformed hunk header yields no hunks");
  const good = fileByPath(files, "good.ts");
  assert.equal(good.hunks.length, 1);
  assert.deepEqual(
    good.hunks[0].lines.map((line) => line.kind),
    ["delete", "add"]
  );
});

test("parseStructuredDiff tracks line numbers across multiple hunks in one file", () => {
  const diff = [
    "diff --git a/multi.ts b/multi.ts",
    "--- a/multi.ts",
    "+++ b/multi.ts",
    "@@ -1,2 +1,2 @@",
    " line1",
    "-line2 old",
    "+line2 new",
    "@@ -10,2 +10,3 @@",
    " line10",
    "+inserted",
    " line11",
    ""
  ].join("\n");

  const file = fileByPath(parseStructuredDiff(diff).files, "multi.ts");
  assert.equal(file.hunks.length, 2);

  const second = file.hunks[1];
  assert.deepEqual(
    second.lines.map((line) => ({ kind: line.kind, o: line.old_line, n: line.new_line })),
    [
      { kind: "context", o: 10, n: 10 },
      { kind: "add", o: undefined, n: 11 },
      { kind: "context", o: 11, n: 12 }
    ]
  );
});

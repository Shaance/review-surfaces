// review-surfaces.SEMANTIC_DIFF.1-4: deterministic facts computed from the
// MEANING of the diff rather than from path/filename matching.
//
//   .1 semantic JSON-schema diff (properties/required/type/enum changes)
//   .2 exported TypeScript API-surface diff (symbols added/removed/changed)
//   .3 test-weakening signals (deleted test files, newly skipped tests, removed
//      assertions, regenerated snapshots)
//   .4 the facts carry concrete language for the queue / lenses / comments.
//
// The base/head file readers are injected so the analysis is a pure function of
// (diff, file contents) — the CLI provides git-backed (base) and working-tree
// (head) readers; tests provide fakes. Schema/API diffs need both file versions;
// test-weakening is computed from the diff hunks alone.

import { StructuredDiff } from "../pr/contract";
import { isTestPath } from "../scope/pr-scope";

export interface SchemaContractChange {
  path: string;
  properties_added: string[];
  properties_removed: string[];
  /** Fields that BECAME required — the common backward-incompatible change. */
  required_added: string[];
  required_removed: string[];
  type_changes: Array<{ field: string; from: string; to: string }>;
  enum_changes: Array<{ field: string; added: string[]; removed: string[] }>;
}

export interface ApiSurfaceChange {
  path: string;
  exports_added: string[];
  exports_removed: string[];
  signatures_changed: Array<{ name: string; from: string; to: string }>;
}

export type TestWeakeningKind = "deleted_test_file" | "skipped_test" | "removed_assertion" | "regenerated_snapshot";

export interface TestWeakeningSignal {
  kind: TestWeakeningKind;
  path: string;
  detail: string;
}

export interface SemanticChangeFacts {
  schema_changes: SchemaContractChange[];
  api_changes: ApiSurfaceChange[];
  test_weakening: TestWeakeningSignal[];
}

export interface SemanticDiffSources {
  diff: StructuredDiff;
  /** Read the OLD (base) content of a path, or undefined when it did not exist. */
  readBase: (path: string) => string | undefined;
  /** Read the NEW (head) content of a path, or undefined when deleted. */
  readHead: (path: string) => string | undefined;
}

export function emptySemanticChangeFacts(): SemanticChangeFacts {
  return { schema_changes: [], api_changes: [], test_weakening: [] };
}

// Shared, surface-agnostic renderings of the two compound schema-change fields,
// so the queue/comment prose (human-review.ts) and the rendered facts section
// (render.ts) cannot drift on the same data shape.
export function formatTypeChanges(changes: SchemaContractChange["type_changes"]): string {
  return changes.map((t) => `${t.field} ${t.from}→${t.to}`).join(", ");
}

export function formatEnumChanges(changes: SchemaContractChange["enum_changes"]): string {
  return changes
    .map((e) => `${e.field}${e.added.length ? ` +[${e.added.join(", ")}]` : ""}${e.removed.length ? ` -[${e.removed.join(", ")}]` : ""}`)
    .join(", ");
}

export function computeSemanticChangeFacts(sources: SemanticDiffSources): SemanticChangeFacts {
  const schema_changes: SchemaContractChange[] = [];
  const api_changes: ApiSurfaceChange[] = [];
  for (const file of sources.diff.files) {
    if (isJsonSchemaPath(file.path)) {
      const change = diffSchemaFile(file.path, sources);
      if (change) {
        schema_changes.push(change);
      }
    } else if (isTypeScriptSourcePath(file.path)) {
      const change = diffApiSurfaceFile(file.path, sources);
      if (change) {
        api_changes.push(change);
      }
    }
  }
  return {
    schema_changes,
    api_changes,
    test_weakening: detectTestWeakening(sources.diff)
  };
}

// --- .1 semantic JSON-schema diff ------------------------------------------

function isJsonSchemaPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".json") && (lower.includes("schema") || lower.includes("/schemas/"));
}

function diffSchemaFile(path: string, sources: SemanticDiffSources): SchemaContractChange | undefined {
  const oldSchema = parseJson(sources.readBase(path));
  const newSchema = parseJson(sources.readHead(path));
  // A pure add or delete is not a CONTRACT change to diff (the path-touched risk
  // already covers it); only a modified schema with both versions is diffed.
  if (oldSchema === undefined || newSchema === undefined) {
    return undefined;
  }
  const change: SchemaContractChange = {
    path,
    properties_added: [],
    properties_removed: [],
    required_added: [],
    required_removed: [],
    type_changes: [],
    enum_changes: []
  };
  diffSchemaNode(oldSchema, newSchema, "", change);
  return isEmptySchemaChange(change) ? undefined : change;
}

// Recursively compare two schema nodes, recording property/required/type/enum
// changes keyed by a readable field path (e.g. "properties.foo" or
// "$defs.bar.baz"). Bounded by the schema's own nesting.
function diffSchemaNode(oldNode: unknown, newNode: unknown, pointer: string, change: SchemaContractChange): void {
  if (!isRecord(oldNode) || !isRecord(newNode)) {
    return;
  }

  // required arrays at this node.
  const oldRequired = stringArray(oldNode.required);
  const newRequired = stringArray(newNode.required);
  for (const field of newRequired) {
    if (!oldRequired.includes(field)) {
      change.required_added.push(fieldPath(pointer, field));
    }
  }
  for (const field of oldRequired) {
    if (!newRequired.includes(field)) {
      change.required_removed.push(fieldPath(pointer, field));
    }
  }

  // type change at this node.
  const oldType = typeLabel(oldNode.type);
  const newType = typeLabel(newNode.type);
  if (oldType !== undefined && newType !== undefined && oldType !== newType) {
    change.type_changes.push({ field: pointer || "(root)", from: oldType, to: newType });
  }

  // enum change at this node. Enum members may be strings, numbers, booleans, or
  // null — compare them as JSON values (so `[1, 2]` → `[1, 3]` is detected) and
  // stringify only for the recorded/displayed value.
  const oldEnum = enumValues(oldNode.enum);
  const newEnum = enumValues(newNode.enum);
  if (oldEnum.length > 0 || newEnum.length > 0) {
    const oldKeys = new Set(oldEnum.map(enumKey));
    const newKeys = new Set(newEnum.map(enumKey));
    const added = newEnum.filter((value) => !oldKeys.has(enumKey(value))).map(enumDisplay);
    const removed = oldEnum.filter((value) => !newKeys.has(enumKey(value))).map(enumDisplay);
    if (added.length > 0 || removed.length > 0) {
      change.enum_changes.push({ field: pointer || "(root)", added, removed });
    }
  }

  // properties / $defs children.
  for (const container of ["properties", "$defs", "definitions"]) {
    const oldChildren = isRecord(oldNode[container]) ? (oldNode[container] as Record<string, unknown>) : {};
    const newChildren = isRecord(newNode[container]) ? (newNode[container] as Record<string, unknown>) : {};
    for (const key of Object.keys(newChildren)) {
      if (!(key in oldChildren)) {
        if (container === "properties") {
          change.properties_added.push(fieldPath(pointer, key));
        }
      } else {
        diffSchemaNode(oldChildren[key], newChildren[key], childPointer(pointer, container, key), change);
      }
    }
    for (const key of Object.keys(oldChildren)) {
      if (!(key in newChildren) && container === "properties") {
        change.properties_removed.push(fieldPath(pointer, key));
      }
    }
  }
}

function isEmptySchemaChange(change: SchemaContractChange): boolean {
  return (
    change.properties_added.length === 0 &&
    change.properties_removed.length === 0 &&
    change.required_added.length === 0 &&
    change.required_removed.length === 0 &&
    change.type_changes.length === 0 &&
    change.enum_changes.length === 0
  );
}

// --- .3 test-weakening signals (from the diff alone) -----------------------

// A test declaration that is skipped, anchored at the start of the (trimmed)
// line so a `.skip(` inside a STRING literal (e.g. a test fixture describing a
// skipped test) does not count as a real skip.
const SKIP_PATTERN = /^\s*(?:(?:describe|it|test|context)\.skip|x(?:it|describe|test|context))\s*\(/;
const ASSERTION_PATTERN = /\b(?:expect|assert)\s*\(|\bassert\.[a-zA-Z]|\.(?:toBe|toEqual|toMatch|toThrow|toContain|deepEqual|strictEqual|ok|equal)\s*\(/;

function detectTestWeakening(diff: StructuredDiff): TestWeakeningSignal[] {
  const signals: TestWeakeningSignal[] = [];
  for (const file of diff.files) {
    if (isSnapshotPath(file.path)) {
      // Only a MODIFIED snapshot is a regeneration that could mask a regression.
      // A newly-added snapshot (status "A") is a new test's first snapshot — there
      // is no prior baseline it could have been regenerated over — so it is not a
      // weakening signal.
      if (file.status === "modified") {
        signals.push({ kind: "regenerated_snapshot", path: file.path, detail: "Snapshot file changed; confirm it was regenerated for an intended behavior change, not to mask a regression." });
      }
      continue;
    }
    if (!isTestPath(file.path)) {
      continue;
    }
    if (file.status === "D") {
      signals.push({ kind: "deleted_test_file", path: file.path, detail: "Test file deleted; confirm its coverage moved elsewhere and was not silently dropped." });
      continue;
    }
    // Skip/assertion weakening needs a prior version to weaken. A brand-new test
    // file (status "A") has none — treating its added lines as "newly skipped" /
    // "removed assertions" would be noise (and its `.skip(` fixture strings would
    // false-fire). A modified OR renamed file does carry prior coverage, so a
    // rename that also disables a test or drops assertions is still inspected.
    if (file.status === "A") {
      continue;
    }
    const added = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add").map((line) => line.text));
    const removed = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "delete").map((line) => line.text));

    // A newly-skipped test: a skip marker added that was not merely moved.
    const addedSkips = added.filter((text) => SKIP_PATTERN.test(text)).length;
    const removedSkips = removed.filter((text) => SKIP_PATTERN.test(text)).length;
    if (addedSkips > removedSkips) {
      signals.push({ kind: "skipped_test", path: file.path, detail: `${addedSkips - removedSkips} test(s) newly skipped; confirm the disabled coverage is intentional.` });
    }

    // Removed assertions: more assertion lines deleted than added. A pure edit
    // (assertion modified, or unrelated change) nets to zero and does NOT fire.
    const addedAsserts = added.filter((text) => ASSERTION_PATTERN.test(text)).length;
    const removedAsserts = removed.filter((text) => ASSERTION_PATTERN.test(text)).length;
    if (removedAsserts > addedAsserts) {
      signals.push({ kind: "removed_assertion", path: file.path, detail: `${removedAsserts - addedAsserts} assertion(s) removed; confirm the checks were not weakened to pass.` });
    }
  }
  return signals;
}

function isSnapshotPath(path: string): boolean {
  return path.endsWith(".snap") || path.endsWith(".snapshot");
}

// --- .2 exported TypeScript API-surface diff -------------------------------

function isTypeScriptSourcePath(path: string): boolean {
  return (/\.tsx?$/.test(path) && !/\.d\.ts$/.test(path)) && !isTestPath(path);
}

function diffApiSurfaceFile(path: string, sources: SemanticDiffSources): ApiSurfaceChange | undefined {
  const oldText = sources.readBase(path);
  const newText = sources.readHead(path);
  // A file present on neither side is not analyzable.
  if (oldText === undefined && newText === undefined) {
    return undefined;
  }
  // An ADDED module (no base) makes all its exports new API surface; a DELETED
  // module (no head) removes all of its exports. Both are concrete add/remove
  // facts SEMANTIC_DIFF.2 should surface, so treat the missing side as no
  // exports rather than skipping the file.
  const oldExports = oldText === undefined ? new Map<string, string>() : extractExports(oldText);
  const newExports = newText === undefined ? new Map<string, string>() : extractExports(newText);
  const change: ApiSurfaceChange = { path, exports_added: [], exports_removed: [], signatures_changed: [] };
  for (const [name, signature] of newExports) {
    const previous = oldExports.get(name);
    if (previous === undefined) {
      change.exports_added.push(name);
    } else if (previous !== signature) {
      change.signatures_changed.push({ name, from: previous, to: signature });
    }
  }
  for (const name of oldExports.keys()) {
    if (!newExports.has(name)) {
      change.exports_removed.push(name);
    }
  }
  if (change.exports_added.length === 0 && change.exports_removed.length === 0 && change.signatures_changed.length === 0) {
    return undefined;
  }
  return change;
}

// Bounded export extractor: maps an exported symbol name to a normalized
// signature string. Not a full TS parse, but the signature carries enough of the
// declaration to detect breaking shape changes: for function/const/class the head
// (params, return type, extends), and for interface/type/enum the full body/RHS —
// so adding a required interface member or changing a type alias is a
// signature change, not invisible.
const EXPORT_DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)([^\n{=;]*)/;

// A declaration whose contract is its body/RHS rather than its head. (A class
// body is intentionally excluded — it is implementation-heavy and member-level
// tracking is beyond this regex-altitude extractor.)
const BODY_DEFINING = new Set(["interface", "type", "enum"]);
const MAX_DECL_LINES = 400;

function extractExports(source: string): Map<string, string> {
  const exports = new Map<string, string>();
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const match = EXPORT_DECL.exec(line);
    if (match) {
      const [, keyword, name, rest] = match;
      if (BODY_DEFINING.has(keyword)) {
        const declaration = captureDeclaration(lines, index);
        exports.set(name, normalizeSignature(declaration.text));
        index = declaration.endIndex;
      } else {
        exports.set(name, normalizeSignature(`${keyword} ${name}${rest}`));
      }
      continue;
    }
    // `export { a, b as c }` named re-exports: track the exported names only.
    const named = /^export\s+(?:type\s+)?\{([^}]*)\}/.exec(line);
    if (named) {
      for (const part of named[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) {
          exports.set(name, `named ${name}`);
        }
      }
    }
  }
  return exports;
}

function normalizeSignature(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Capture a full single-statement declaration starting at `startIndex`, joining
// continuation lines until the statement closes: the first `;` at bracket depth 0
// (type aliases), or the line where an opened `{`/`(`/`[` balances back to 0
// (interface/enum/object bodies). Bounded by MAX_DECL_LINES so a malformed or
// unterminated source can never loop unboundedly; base and head are captured by
// the same rule, so a real body change is detected and a non-change is not.
function captureDeclaration(lines: string[], startIndex: number): { text: string; endIndex: number } {
  let depth = 0;
  let opened = false;
  const parts: string[] = [];
  const end = Math.min(lines.length, startIndex + MAX_DECL_LINES);
  for (let index = startIndex; index < end; index += 1) {
    const line = lines[index];
    parts.push(line.trim());
    for (const char of line) {
      if (char === "{" || char === "(" || char === "[") {
        depth += 1;
        opened = true;
      } else if (char === "}" || char === ")" || char === "]") {
        depth -= 1;
      } else if (char === ";" && depth <= 0) {
        return { text: parts.join(" "), endIndex: index };
      }
    }
    if (opened && depth <= 0) {
      return { text: parts.join(" "), endIndex: index };
    }
  }
  return { text: parts.join(" "), endIndex: end - 1 };
}

// --- helpers ---------------------------------------------------------------

function parseJson(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function enumValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// A canonical identity key for an enum member, so members are compared as JSON
// values rather than by string identity (`1` and `"1"` are distinct members).
function enumKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

// The recorded/displayed form of an enum member: strings as-is, everything else
// (numbers, booleans, null) as its JSON literal.
function enumDisplay(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

function typeLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string").join("|") || undefined;
  }
  return undefined;
}

function fieldPath(pointer: string, field: string): string {
  return pointer ? `${pointer}.${field}` : field;
}

function childPointer(pointer: string, container: string, key: string): string {
  const head = pointer ? `${pointer}.${container}` : container;
  return `${head}.${key}`;
}

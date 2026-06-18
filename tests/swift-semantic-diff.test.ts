import test from "node:test";
import assert from "node:assert/strict";
import { cleanSwiftSource } from "../src/risks/swift-lexer";
import { extractSwiftDeclarations } from "../src/risks/swift-declarations";
import { diffSwiftDeclarations } from "../src/risks/swift-semantic-diff";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { computeSemanticChangeFacts, SemanticDiffSources } from "../src/risks/semantic-diff";

// ---------------------------------------------------------------------------
// review-surfaces.SEMANTIC_DIFF.5 / .6 — Swift lexer, declaration scanner, and
// deterministic declaration-change + test-weakening facts.
// ---------------------------------------------------------------------------

const names = (source: string): string[] => extractSwiftDeclarations(source).map((d) => `${d.kind}:${d.container ? `${d.container}.` : ""}${d.name}`);

test("review-surfaces.SEMANTIC_DIFF.5 the lexer blanks comments and strings (no declaration leaks from them)", () => {
  const source = [
    "// public struct CommentStruct {}",
    "/* nested /* public func ghost() */ still comment */",
    'let s = "public struct StringStruct {}"',
    'let m = """',
    "public func multilineGhost() {}",
    '"""',
    'let raw = #"public enum RawEnum {}"#',
    "public struct Real {}"
  ].join("\n");
  const cleaned = cleanSwiftSource(source);
  // Comment/string contents are gone; the real declaration survives.
  assert.ok(!cleaned.includes("CommentStruct"));
  assert.ok(!cleaned.includes("StringStruct"));
  assert.ok(!cleaned.includes("multilineGhost"));
  assert.ok(!cleaned.includes("RawEnum"));
  assert.ok(cleaned.includes("struct Real"));
  // Newlines are preserved so line numbers stay accurate.
  assert.equal(cleaned.split("\n").length, source.split("\n").length);
  // Only the real declaration (and the top-level `let`s) are scanned.
  const decls = extractSwiftDeclarations(source);
  assert.ok(decls.some((d) => d.kind === "struct" && d.name === "Real"));
  assert.ok(!decls.some((d) => /Ghost|CommentStruct|StringStruct|RawEnum/.test(d.name)));
});

test("review-surfaces.SEMANTIC_DIFF.5 the scanner does not capture locals inside function bodies", () => {
  const source = [
    "struct Box {",
    "  func work() {",
    "    let local = 1",
    "    var mutableLocal = 2",
    "    switch local { case 0: break; default: break }",
    "  }",
    "}"
  ].join("\n");
  const declNames = names(source);
  assert.deepEqual(declNames.sort(), ["function:Box.work", "struct:Box"].sort());
  // No local let/var/case leaked as a declaration.
  assert.ok(!declNames.some((n) => /local|mutableLocal/.test(n)));
});

test("review-surfaces.SEMANTIC_DIFF.5 captures visibility, conformances, enum cases, and protocol requirements", () => {
  const source = [
    "public final class Repo: NSObject, Codable {",
    "  open func load() {}",
    "}",
    "public enum Suit: String { case spades, hearts; case clubs }",
    "public protocol Loader { func load() async throws; var name: String { get } }"
  ].join("\n");
  const decls = extractSwiftDeclarations(source);
  const repo = decls.find((d) => d.name === "Repo");
  assert.equal(repo?.visibility, "public");
  assert.deepEqual(repo?.conformances, ["NSObject", "Codable"]);
  const suit = decls.find((d) => d.name === "Suit");
  assert.deepEqual(suit?.enum_cases, ["spades", "hearts", "clubs"]);
  const loader = decls.find((d) => d.name === "Loader");
  assert.deepEqual(loader?.protocol_requirements?.sort(), ["load", "name"].sort());
  // A protocol requirement inherits the protocol's public surface.
  const loaderLoad = decls.find((d) => d.kind === "function" && d.container === "Loader");
  assert.equal(loaderLoad?.visibility, "public");
});

test("review-surfaces.SEMANTIC_DIFF.5 a body-only edit produces NO declaration-contract fact", () => {
  const base = "public struct S {\n  public func f() -> Int { return 1 }\n}\n";
  const head = "public struct S {\n  public func f() -> Int { let x = 41; return x + 1 }\n}\n";
  assert.equal(diffSwiftDeclarations("S.swift", base, head).length, 0);
});

test("review-surfaces.SEMANTIC_DIFF.5 reports a public signature/parameter change to the API-contract surface", () => {
  const base = "public struct S {\n  public func greet(name: String) -> String { return name }\n}\n";
  const head = "public struct S {\n  public func greet(name: String, loudly: Bool) -> String { return name }\n}\n";
  const changes = diffSwiftDeclarations("S.swift", base, head);
  const change = changes.find((c) => c.name === "S.greet");
  assert.ok(change, "a signature change is reported");
  assert.equal(change!.change, "modified");
  assert.equal(change!.breaking, true, "a public signature change is breaking");
});

test("review-surfaces.SEMANTIC_DIFF.5 reports async/throws and global-actor isolation changes", () => {
  const base = "@MainActor public final class VM {\n  public func reload() async throws {}\n}\n";
  const head = "public final class VM {\n  public func reload() {}\n}\n";
  const changes = diffSwiftDeclarations("VM.swift", base, head);
  const fn = changes.find((c) => c.name === "VM.reload");
  assert.ok(/no longer async|no longer throwing/.test(fn?.detail ?? ""), "async/throws drop is reported");
  const vm = changes.find((c) => c.name === "VM" && c.change === "modified");
  assert.ok(/actor isolation/.test(vm?.detail ?? ""), "global-actor removal is reported");
});

test("review-surfaces.SEMANTIC_DIFF.5 reports a removed enum case and a new protocol requirement as breaking", () => {
  const base = "public enum E { case a, b }\npublic protocol P { func one() }\n";
  const head = "public enum E { case a }\npublic protocol P { func one(); func two() }\n";
  const changes = diffSwiftDeclarations("x.swift", base, head);
  const enumChange = changes.find((c) => c.name === "E");
  assert.ok(/enum case\(s\) removed: b/.test(enumChange?.detail ?? ""));
  assert.equal(enumChange?.breaking, true);
  const protoChange = changes.find((c) => c.name === "P");
  assert.ok(/protocol requirement\(s\) added: two/.test(protoChange?.detail ?? ""));
  assert.equal(protoChange?.breaking, true);
});

test("review-surfaces.SEMANTIC_DIFF.5 added/removed public declarations, and a removed public decl is breaking", () => {
  const base = "public struct A {}\npublic func gone() {}\n";
  const head = "public struct A {}\npublic struct Added {}\n";
  const changes = diffSwiftDeclarations("x.swift", base, head);
  const removed = changes.find((c) => c.name === "gone");
  assert.equal(removed?.change, "removed");
  assert.equal(removed?.breaking, true);
  const added = changes.find((c) => c.name === "Added");
  assert.equal(added?.change, "added");
  assert.equal(added?.breaking, false, "an addition is not breaking");
});

test("review-surfaces.SEMANTIC_DIFF.5 an ambiguous overload set produces no guessed fact", () => {
  // Two funcs named `send` (an overload set): a change is ambiguous, so omitted.
  const base = "struct S {\n  func send(_ x: Int) {}\n  func send(_ x: String) {}\n}\n";
  const head = "struct S {\n  func send(_ x: Int64) {}\n  func send(_ x: String) {}\n}\n";
  assert.equal(diffSwiftDeclarations("S.swift", base, head).length, 0, "ambiguous overload change is omitted");
});

test("review-surfaces.SEMANTIC_DIFF.5 unsupported/malformed input never throws and yields no fact", () => {
  for (const junk of ["", "@@@ not swift", 'let x = "unterminated', "struct {", "/* unterminated comment", "func ("]) {
    assert.doesNotThrow(() => extractSwiftDeclarations(junk));
    assert.doesNotThrow(() => diffSwiftDeclarations("j.swift", junk, junk));
  }
});

// --- SEMANTIC_DIFF.5 through the full computeSemanticChangeFacts path --------

function sources(diffText: string, base: Record<string, string>, head: Record<string, string>): SemanticDiffSources {
  return { diff: parseStructuredDiff(diffText), readBase: (p) => base[p], readHead: (p) => head[p] };
}

test("review-surfaces.SEMANTIC_DIFF.5 swift_declaration_changes flow through computeSemanticChangeFacts", () => {
  const path = "Sources/App/Greeter.swift";
  const base = "public struct Greeter {\n  public func greet() -> String { return \"hi\" }\n}\n";
  const head = "public struct Greeter {\n  func greet() -> String { return \"hi\" }\n}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,3 @@", "-  public func greet", "+  func greet", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: base }, { [path]: head }));
  assert.equal(facts.swift_declaration_changes.length, 1);
  assert.ok(/access narrowed public → internal/.test(facts.swift_declaration_changes[0].detail));
  // A Swift implementation file is NOT mistaken for a TypeScript API change.
  assert.equal(facts.api_changes.length, 0);
});

// --- SEMANTIC_DIFF.6 Swift test weakening -----------------------------------

test("review-surfaces.SEMANTIC_DIFF.6 fires on a removed XCTAssert / #expect, not on a modified one", () => {
  const path = "Tests/AppTests/GreeterTests.swift";
  const removed = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,4 +1,3 @@",
    "   func testGreet() {",
    "-    XCTAssertEqual(g.greet(), \"hi\")",
    "     g.warmUp()",
    "   }",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(removed, {}, {})).test_weakening;
  assert.ok(weakening.some((s) => s.kind === "removed_assertion" && s.path === path), "removed XCTAssert fires");

  const modified = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    "   func testGreet() {",
    "-    #expect(g.greet() == \"hi\")",
    "+    #expect(g.greet() == \"hello\")",
    "   }",
    ""
  ].join("\n");
  assert.ok(!computeSemanticChangeFacts(sources(modified, {}, {})).test_weakening.some((s) => s.kind === "removed_assertion"), "a modified #expect nets to zero");
});

test("review-surfaces.SEMANTIC_DIFF.6 fires on a newly skipped/disabled Swift test and a deleted Swift test file", () => {
  const path = "Tests/AppTests/FlowTests.swift";
  const skipped = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,3 @@",
    "   func testFlow() throws {",
    "+    try XCTSkipIf(true)",
    "   }",
    ""
  ].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(skipped, {}, {})).test_weakening.some((s) => s.kind === "skipped_test"), "XCTSkipIf fires skipped_test");

  const disabled = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    "-@Test func a() {}",
    "+@Test(.disabled(\"flaky\")) func a() {}",
    ""
  ].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(disabled, {}, {})).test_weakening.some((s) => s.kind === "skipped_test"), "Swift Testing .disabled trait fires");

  const deleted = [`diff --git a/${path} b/${path}`, "deleted file mode 100644", `--- a/${path}`, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-import XCTest", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(deleted, {}, {})).test_weakening.some((s) => s.kind === "deleted_test_file"), "deleted Swift test file fires");
});

test("review-surfaces.SEMANTIC_DIFF.6 a Swift implementation body change is NOT a test weakening", () => {
  const path = "Sources/App/Greeter.swift";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    "   func greet() {",
    "-    log()",
    "   }",
    ""
  ].join("\n");
  assert.equal(computeSemanticChangeFacts(sources(diffText, { [path]: "" }, { [path]: "" })).test_weakening.length, 0);
});

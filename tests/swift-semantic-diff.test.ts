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

// --- Phase 2 Codex round 1: parser/semantic correctness regressions ----------

test("review-surfaces.SEMANTIC_DIFF.5 a next-line opening brace still scopes the body (no leaked local decl)", () => {
  const base = "public struct S {\n  public func run()\n  {\n    let local = 1\n    doThing()\n  }\n}\n";
  const head = "public struct S {\n  public func run()\n  {\n    let local = 2\n    doThing()\n  }\n}\n";
  assert.equal(diffSwiftDeclarations("S.swift", base, head).length, 0, "a body-only edit under a next-line brace is not a contract change");
  assert.ok(!extractSwiftDeclarations(base).some((d) => d.name === "local"), "a local inside a next-line-brace body never leaks as a top-level declaration");
});

test("review-surfaces.SEMANTIC_DIFF.5 a public global-actor change is a contract break", () => {
  const base = "public final class VM {\n  public func reload() {}\n}\n";
  const head = "@MainActor public final class VM {\n  public func reload() {}\n}\n";
  const vm = diffSwiftDeclarations("VM.swift", base, head).find((c) => c.name === "VM" && c.change === "modified");
  assert.ok(/actor isolation/.test(vm?.detail ?? ""), "the global-actor change is reported");
  assert.equal(vm?.breaking, true, "a public @MainActor addition is breaking");
});

test("review-surfaces.SEMANTIC_DIFF.5 a new public protocol associatedtype is a breaking requirement", () => {
  const base = "public protocol Store {\n  func load()\n}\n";
  const head = "public protocol Store {\n  associatedtype Element\n  func load()\n}\n";
  const change = diffSwiftDeclarations("Store.swift", base, head).find((c) => c.name === "Store");
  assert.ok(/protocol requirement\(s\) added: Element/.test(change?.detail ?? ""), "associatedtype is recorded as a protocol requirement");
  assert.equal(change?.breaking, true);
});

test("review-surfaces.SEMANTIC_DIFF.5 a member of a public extension is public (its removal is breaking)", () => {
  const base = "public extension Foo {\n  func bar() {}\n}\n";
  const head = "public extension Foo {\n}\n";
  const removed = diffSwiftDeclarations("Foo.swift", base, head).find((c) => /bar/.test(c.name) && c.change === "removed");
  assert.ok(removed, "the public-extension member is tracked as removed");
  assert.equal(removed?.breaking, true, "a public-extension member removal is breaking");
});

test("review-surfaces.SEMANTIC_DIFF.5 an @unchecked Sendable conformance is recorded", () => {
  const base = "public final class Cache {}\n";
  const head = "public final class Cache: @unchecked Sendable {}\n";
  const change = diffSwiftDeclarations("Cache.swift", base, head).find((c) => c.name === "Cache");
  assert.ok(change, "the conformance change is reported");
  assert.ok(/Sendable/.test(change?.detail ?? ""), "the @unchecked Sendable conformance add is detected");
});

test("review-surfaces.SEMANTIC_DIFF.5 a Package.swift manifest is not declaration-diffed", () => {
  const path = "Package.swift";
  const base = 'let package = Package(name: "A", targets: [])\n';
  const head = 'let package = Package(name: "A", targets: [.target(name: "A")])\n';
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    '-let package = Package(name: "A", targets: [])',
    '+let package = Package(name: "A", targets: [.target(name: "A")])',
    ""
  ].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: base }, { [path]: head }));
  assert.equal(facts.swift_declaration_changes.length, 0, "Package.swift is left to the package/config fact paths");
});

test("review-surfaces.SEMANTIC_DIFF.6 fires removed_test_method when a whole test method is deleted (no assertion)", () => {
  const path = "Tests/AppTests/SmokeTests.swift";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,5 +1,1 @@",
    "-  func testSmoke() throws {",
    "-    try service.run()",
    "-  }",
    "   func testOther() {}",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(weakening.some((s) => s.kind === "removed_test_method" && s.path === path), "a deleted smoke test with no assertion still fires");
});

test("review-surfaces.SEMANTIC_DIFF.6 a .disabled( inside a Swift string/comment does not count as a skip", () => {
  const path = "Tests/AppTests/FixtureTests.swift";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,2 @@",
    "   func testFixtures() {",
    '+    let sample = ".disabled(x)" // XCTSkipIf in a comment',
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(!weakening.some((s) => s.kind === "skipped_test"), "skip markers inside strings/comments are ignored");
});

// --- Phase 2 Codex round 2: deeper parser/semantic regressions ---------------

test("review-surfaces.SEMANTIC_DIFF.5 a wrapped effect clause (async/throws on the next line) is parsed", () => {
  const base = "public struct S {\n  public func run()\n    async throws\n  {\n    let local = 1\n  }\n}\n";
  const head = "public struct S {\n  public func run()\n  {\n    let local = 1\n  }\n}\n";
  const change = diffSwiftDeclarations("S.swift", base, head).find((c) => c.name === "S.run");
  assert.ok(/no longer async|no longer throwing/.test(change?.detail ?? ""), "the wrapped effect drop is captured");
  assert.ok(!extractSwiftDeclarations(base).some((d) => d.name === "local"), "a body local under a wrapped-effect head does not leak");
});

test("review-surfaces.SEMANTIC_DIFF.5 a static modifier change on a public member is a contract change", () => {
  const base = "public enum API {\n  public func f() {}\n}\n";
  const head = "public enum API {\n  public static func f() {}\n}\n";
  const change = diffSwiftDeclarations("API.swift", base, head).find((c) => c.name === "API.f");
  assert.ok(change, "the modifier change is reported");
  assert.ok(/modifier/.test(change?.detail ?? ""), "the static addition is described");
  assert.equal(change?.breaking, true, "a public modifier change is breaking");
});

test("review-surfaces.SEMANTIC_DIFF.5 a protocol property gaining a setter is a breaking requirement change", () => {
  const base = "public protocol Model {\n  var value: Int { get }\n}\n";
  const head = "public protocol Model {\n  var value: Int { get set }\n}\n";
  const change = diffSwiftDeclarations("Model.swift", base, head).find((c) => /value/.test(c.name) && c.change === "modified");
  assert.ok(change, "the accessor change is reported");
  assert.equal(change?.breaking, true, "get -> get set breaks conformers");
});

test("review-surfaces.SEMANTIC_DIFF.5 a conformance added via a second extension is not dropped as ambiguous", () => {
  const base = "extension Foo {\n  func a() {}\n}\n";
  const head = "extension Foo {\n  func a() {}\n}\nextension Foo: Sendable {\n}\n";
  const changes = diffSwiftDeclarations("Foo.swift", base, head);
  const added = changes.find((c) => c.kind === "extension" && c.change === "added");
  assert.ok(added, "the conforming extension is surfaced (not omitted as ambiguous)");
  assert.ok(/Sendable/.test(added?.detail ?? ""), "the added conformance is named in the detail");
});

test("review-surfaces.SEMANTIC_DIFF.5 a stacked @preconcurrency @unchecked Sendable conformance is recorded", () => {
  const base = "public final class Cache {}\n";
  const head = "public final class Cache: @preconcurrency @unchecked Sendable {}\n";
  const change = diffSwiftDeclarations("Cache.swift", base, head).find((c) => c.name === "Cache");
  assert.ok(/Sendable/.test(change?.detail ?? ""), "stacked conformance attributes are stripped and Sendable recorded");
});

test("review-surfaces.SEMANTIC_DIFF.6 a .disabled( inside a multiline Swift string does not count as a skip", () => {
  const path = "Tests/AppTests/FixtureTests.swift";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,4 @@",
    "   func testFixtures() {",
    '+    let fixture = """',
    '+    sample .disabled("x") text',
    '+    """',
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(!weakening.some((s) => s.kind === "skipped_test"), "a skip marker inside a multiline string is ignored");
});

test("review-surfaces.SEMANTIC_DIFF.6 detects an Xcode test plan disabling a test/target", () => {
  const path = "Plans/Unit.xctestplan";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,4 @@",
    "       {",
    '+        "enabled" : false,',
    '         "target" : { "name" : "AppTests" }',
    "       }",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(weakening.some((s) => s.kind === "skipped_test" && s.path === path), "a disabled test-plan entry fires skipped_test");
});

// --- Phase 2 Codex round 3: bug fixes (parser-completeness tail bounded) ------

test("review-surfaces.SEMANTIC_DIFF.5 narrowing a setter to private(set) is a contract change", () => {
  const base = "public struct S {\n  public var count = 0\n}\n";
  const head = "public struct S {\n  public private(set) var count = 0\n}\n";
  const change = diffSwiftDeclarations("S.swift", base, head).find((c) => c.name === "S.count");
  assert.ok(change, "the setter-access narrowing is reported (private(set) kept in identity)");
  assert.ok(/modifier/.test(change?.detail ?? ""));
});

test("review-surfaces.SEMANTIC_DIFF.5 removing a conformance declared via an extension is breaking", () => {
  const base = "extension Foo: Sendable {}\n";
  const head = "\n";
  const change = diffSwiftDeclarations("Foo.swift", base, head).find((c) => c.kind === "extension" && c.change === "removed");
  assert.ok(change, "the removed conforming extension is reported");
  assert.equal(change?.breaking, true, "removing a conformance breaks callers regardless of the extension's own access");
  assert.ok(/Sendable/.test(change?.detail ?? ""), "the removed conformance is named");
});

test("review-surfaces.SEMANTIC_DIFF.5 a Swift impl renamed OUT of source reports the removed public API", () => {
  const oldPath = "Sources/App/API.swift";
  const newPath = "Sources/App/API.swift.disabled";
  const base = "public struct API {\n  public func run() {}\n}\n";
  const diffText = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 100%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    ""
  ].join("\n");
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (p) => (p === oldPath ? base : undefined),
    readHead: () => undefined
  });
  assert.ok(
    facts.swift_declaration_changes.some((c) => c.change === "removed" && /API/.test(c.name)),
    "public Swift API that left the module is reported as removed"
  );
});

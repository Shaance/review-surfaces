// review-surfaces.SEMANTIC_DIFF.5 — deterministic Swift declaration-change facts.
// Compares the base/head declaration indexes (swift-declarations.ts) and emits
// concrete add/remove/signature/conformance/enum-case/protocol-requirement/
// concurrency/visibility changes, WITHOUT claiming compiler completeness. An
// ambiguous key (an overload set: the same container+kind+name appearing more
// than once) is omitted rather than guessed (goal contract D6/D10).

import { extractSwiftDeclarations, SwiftDeclaration, SwiftDeclarationKind, SwiftVisibility } from "./swift-declarations";

export interface SwiftDeclarationChange {
  path: string;
  // Container-qualified name, e.g. "Greeter.greet" or "Greeter".
  name: string;
  kind: SwiftDeclarationKind;
  change: "added" | "removed" | "modified";
  visibility: SwiftVisibility;
  // True when the change is contract-relevant for a public/package/open surface,
  // a removed enum case, or a changed/removed protocol requirement.
  breaking: boolean;
  detail: string;
  // review-surfaces.BLAST_RADIUS.4: in-target files that reference a unique type
  // declared in this file. Absent when the symbol graph was not computed; a
  // truncated graph carries the flag rather than a false "used by 0".
  used_by?: { count: number; top: string[]; truncated?: boolean };
}

const CONTRACT_VISIBILITIES = new Set<SwiftVisibility>(["open", "public", "package"]);
const VISIBILITY_RANK: Record<SwiftVisibility, number> = {
  private: 0,
  fileprivate: 1,
  internal: 2,
  package: 3,
  public: 4,
  open: 5
};

// Concurrency/effect markers read off the normalized signature + attributes.
interface DeclShape {
  decl: SwiftDeclaration;
  isAsync: boolean;
  throwsEffect: boolean;
  globalActor?: string;
  sendable: boolean;
  normalizedSignature: string;
}

function declKey(decl: SwiftDeclaration): string {
  const base = `${decl.container ?? ""}::${decl.kind}::${decl.name}`;
  // A file commonly has several `extension Foo` blocks; keying only by name would mark
  // them all ambiguous and drop a conformance change. Fold the sorted conformances into
  // an extension's key so `extension Foo {}` and `extension Foo: Sendable {}` are
  // distinct — adding the conforming extension is then reported, not omitted.
  if (decl.kind === "extension") {
    return `${base}::${[...decl.conformances].sort().join(",")}`;
  }
  return base;
}

function qualifiedName(decl: SwiftDeclaration): string {
  return decl.container ? `${decl.container}.${decl.name}` : decl.name;
}

// Access keywords are captured by `visibility`; the REMAINING modifiers (`static`,
// `class`, `mutating`, `nonisolated`, `final`, `override`, …) are part of the callable
// interface, so a change to them is a declaration change even when nothing else does.
const ACCESS_MODIFIERS = new Set(["public", "private", "internal", "fileprivate", "package", "open"]);
function semanticModifiers(decl: SwiftDeclaration): string[] {
  return [...(decl.modifiers ?? [])]
    .filter((modifier) => {
      // Keep setter-scope modifiers (`private(set)`, `internal(set)`, …) verbatim: they
      // narrow the SETTER, a callable-interface change distinct from the getter's
      // visibility. Drop plain access keywords (already captured by `visibility`).
      if (/\(set\)$/.test(modifier)) {
        return true;
      }
      return !ACCESS_MODIFIERS.has(modifier.split("(")[0]);
    })
    .sort();
}

function shapeOf(decl: SwiftDeclaration): DeclShape {
  const sig = decl.signature;
  const globalActor = decl.attributes
    .map((attr) => /^@(MainActor|[A-Z][A-Za-z0-9_]*Actor)\b/.exec(attr)?.[1])
    .find((value): value is string => Boolean(value));
  return {
    decl,
    isAsync: /\basync\b/.test(sig),
    throwsEffect: /\b(?:throws|rethrows)\b/.test(sig),
    globalActor,
    sendable: decl.conformances.includes("Sendable"),
    normalizedSignature: sig
  };
}

// A normalized identity used to decide whether a matched declaration CHANGED.
function identityOf(shape: DeclShape): string {
  const d = shape.decl;
  return JSON.stringify([
    shape.normalizedSignature,
    d.visibility,
    semanticModifiers(d),
    [...d.conformances].sort(),
    [...(d.enum_cases ?? [])].sort(),
    [...(d.protocol_requirements ?? [])].sort(),
    shape.globalActor ?? "",
    shape.isAsync,
    shape.throwsEffect
  ]);
}

function indexByKey(decls: SwiftDeclaration[]): Map<string, DeclShape | "ambiguous"> {
  const seen = new Map<string, DeclShape | "ambiguous">();
  for (const decl of decls) {
    const key = declKey(decl);
    if (seen.has(key)) {
      seen.set(key, "ambiguous");
    } else {
      seen.set(key, shapeOf(decl));
    }
  }
  return seen;
}

export function diffSwiftDeclarations(path: string, baseSource: string | undefined, headSource: string | undefined): SwiftDeclarationChange[] {
  const baseDecls = baseSource ? extractSwiftDeclarations(baseSource) : [];
  const headDecls = headSource ? extractSwiftDeclarations(headSource) : [];
  const base = indexByKey(baseDecls);
  const head = indexByKey(headDecls);
  const changes: SwiftDeclarationChange[] = [];
  const keys = new Set<string>([...base.keys(), ...head.keys()]);

  for (const key of [...keys].sort()) {
    const b = base.get(key);
    const h = head.get(key);
    // Ambiguous on either side: omit (never guess across an overload set).
    if (b === "ambiguous" || h === "ambiguous") {
      continue;
    }
    if (!b && h) {
      changes.push(addedChange(path, h));
      continue;
    }
    if (b && !h) {
      changes.push(removedChange(path, b));
      continue;
    }
    if (b && h && identityOf(b) !== identityOf(h)) {
      const change = modifiedChange(path, b, h);
      if (change) {
        changes.push(change);
      }
    }
  }
  return changes;
}

function addedChange(path: string, shape: DeclShape): SwiftDeclarationChange {
  const d = shape.decl;
  // A new `extension Foo: Sendable {}` ADDS those conformances to Foo — name them so a
  // conformance/isolation change made via a fresh extension is concrete, not just
  // "extension added" (SEMANTIC_DIFF.5).
  const conformanceNote = d.kind === "extension" && d.conformances.length > 0 ? ` adding conformance(s): ${[...d.conformances].sort().join(", ")}` : "";
  return {
    path,
    name: qualifiedName(d),
    kind: d.kind,
    change: "added",
    visibility: d.visibility,
    // Additions are generally lower severity; a NEW protocol requirement is a
    // contract change for every conformer even within a target.
    breaking: d.kind === "protocol" ? false : false,
    detail: `${kindLabel(d.kind)} \`${qualifiedName(d)}\` added (${d.visibility})${conformanceNote}.`
  };
}

function removedChange(path: string, shape: DeclShape): SwiftDeclarationChange {
  const d = shape.decl;
  // Removing an extension that DECLARED conformances (`extension Foo: Sendable {}`) is a
  // break regardless of the extension keyword's own access: the conformance's visibility
  // follows the conformed type, and callers relying on `Foo: Sendable/Codable` no longer
  // compile. A plain extension defaults to `internal`, so its access alone misses this.
  const removedConformanceBreak = d.kind === "extension" && d.conformances.length > 0;
  const breaking = CONTRACT_VISIBILITIES.has(d.visibility) || removedConformanceBreak;
  const conformanceNote = removedConformanceBreak ? ` removing conformance(s): ${[...d.conformances].sort().join(", ")}` : "";
  return {
    path,
    name: qualifiedName(d),
    kind: d.kind,
    change: "removed",
    visibility: d.visibility,
    breaking,
    detail: `${kindLabel(d.kind)} \`${qualifiedName(d)}\` removed (${d.visibility})${conformanceNote}${breaking && !removedConformanceBreak ? " — a public/package API removal" : ""}.`
  };
}

function modifiedChange(path: string, b: DeclShape, h: DeclShape): SwiftDeclarationChange | undefined {
  const parts: string[] = [];
  let breaking = false;
  const d = h.decl;

  // Visibility widening/narrowing.
  if (b.decl.visibility !== h.decl.visibility) {
    const widened = VISIBILITY_RANK[h.decl.visibility] > VISIBILITY_RANK[b.decl.visibility];
    parts.push(`access ${widened ? "widened" : "narrowed"} ${b.decl.visibility} → ${h.decl.visibility}`);
    if (!widened && CONTRACT_VISIBILITIES.has(b.decl.visibility)) {
      breaking = true; // narrowing a public/package surface breaks callers
    }
  }

  // Modifier changes (static/class/mutating/nonisolated/final/…) — a callable-interface
  // change on a public/package/open surface.
  const modAdded = diffList(semanticModifiers(b.decl), semanticModifiers(h.decl));
  const modRemoved = diffList(semanticModifiers(h.decl), semanticModifiers(b.decl));
  if (modAdded.length || modRemoved.length) {
    const bits: string[] = [];
    if (modAdded.length) bits.push(`+${modAdded.join(" +")}`);
    if (modRemoved.length) bits.push(`-${modRemoved.join(" -")}`);
    parts.push(`modifier(s) changed: ${bits.join(" ")}`);
    breaking = breaking || CONTRACT_VISIBILITIES.has(h.decl.visibility);
  }

  // Conformance / superclass changes.
  const confAdded = diffList(b.decl.conformances, h.decl.conformances);
  const confRemoved = diffList(h.decl.conformances, b.decl.conformances);
  if (confAdded.length) {
    parts.push(`conformance(s) added: ${confAdded.join(", ")}`);
  }
  if (confRemoved.length) {
    parts.push(`conformance(s) removed: ${confRemoved.join(", ")}`);
    if (CONTRACT_VISIBILITIES.has(h.decl.visibility)) {
      breaking = true;
    }
  }

  // Enum cases.
  const casesAdded = diffList(b.decl.enum_cases ?? [], h.decl.enum_cases ?? []);
  const casesRemoved = diffList(h.decl.enum_cases ?? [], b.decl.enum_cases ?? []);
  if (casesAdded.length) {
    parts.push(`enum case(s) added: ${casesAdded.join(", ")}`);
  }
  if (casesRemoved.length) {
    parts.push(`enum case(s) removed: ${casesRemoved.join(", ")}`);
    breaking = true; // a removed case breaks exhaustive switches and decoders
  }

  // Protocol requirements.
  const reqAdded = diffList(b.decl.protocol_requirements ?? [], h.decl.protocol_requirements ?? []);
  const reqRemoved = diffList(h.decl.protocol_requirements ?? [], b.decl.protocol_requirements ?? []);
  if (reqAdded.length) {
    parts.push(`protocol requirement(s) added: ${reqAdded.join(", ")}`);
    breaking = true; // a new requirement breaks existing conformers
  }
  if (reqRemoved.length) {
    parts.push(`protocol requirement(s) removed: ${reqRemoved.join(", ")}`);
  }

  // Concurrency / effects.
  if (b.isAsync !== h.isAsync) {
    parts.push(`${h.isAsync ? "became async" : "no longer async"}`);
    breaking = breaking || CONTRACT_VISIBILITIES.has(h.decl.visibility);
  }
  if (b.throwsEffect !== h.throwsEffect) {
    parts.push(`${h.throwsEffect ? "became throwing" : "no longer throwing"}`);
    breaking = breaking || CONTRACT_VISIBILITIES.has(h.decl.visibility);
  }
  if ((b.globalActor ?? "") !== (h.globalActor ?? "")) {
    parts.push(`actor isolation ${b.globalActor ? `from @${b.globalActor}` : "added"} ${h.globalActor ? `→ @${h.globalActor}` : "removed"}`.replace(/\s+/g, " ").trim());
    // Global-actor isolation (e.g. @MainActor) is part of the callable interface — a
    // public/package/open change forces call-site/conformance updates, so it breaks.
    breaking = breaking || CONTRACT_VISIBILITIES.has(h.decl.visibility);
  }

  // Fallback: a signature change we did not decompose (parameters / return type).
  if (parts.length === 0 && b.normalizedSignature !== h.normalizedSignature) {
    parts.push("signature changed");
    breaking = breaking || CONTRACT_VISIBILITIES.has(h.decl.visibility);
  }

  if (parts.length === 0) {
    return undefined;
  }
  return {
    path,
    name: qualifiedName(d),
    kind: d.kind,
    change: "modified",
    visibility: d.visibility,
    breaking,
    detail: `${kindLabel(d.kind)} \`${qualifiedName(d)}\`: ${parts.join("; ")}.`
  };
}

function diffList(from: string[], to: string[]): string[] {
  const fromSet = new Set(from);
  return [...new Set(to.filter((item) => !fromSet.has(item)))].sort();
}

function kindLabel(kind: SwiftDeclarationKind): string {
  switch (kind) {
    case "function":
      return "Swift function";
    case "initializer":
      return "Swift initializer";
    case "subscript":
      return "Swift subscript";
    case "property":
      return "Swift property";
    case "typealias":
      return "Swift typealias";
    case "case":
      return "Swift enum case";
    default:
      return `Swift ${kind}`;
  }
}

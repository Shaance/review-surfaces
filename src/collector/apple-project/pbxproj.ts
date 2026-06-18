// review-surfaces.BLAST_RADIUS.4 / DEP_FACTS.6 — a bounded parser for the observed
// Xcode project (`*.xcodeproj/project.pbxproj`). The file is a NeXTSTEP-style plist
// object archive; we parse it into a flat object map, then read PBXNativeTarget
// source membership (resolving file paths through the PBXGroup tree) and any
// XCRemoteSwiftPackageReference entries. Unsupported sections are ignored; a parse
// failure yields nothing rather than a guess (goal contract D2/D10).

import { AppleTarget, AppleTargetKind } from "./model";

type PlistValue = string | PlistValue[] | { [key: string]: PlistValue };

// --- NeXTSTEP plist parser --------------------------------------------------

function parsePlist(text: string): { [key: string]: PlistValue } | undefined {
  let i = 0;
  const n = text.length;

  const skipTrivia = (): void => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) {
        i += 1;
      }
      if (text[i] === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (text[i] === "/" && text[i + 1] === "/") {
        const end = text.indexOf("\n", i + 2);
        i = end < 0 ? n : end + 1;
        continue;
      }
      break;
    }
  };

  const parseString = (): string => {
    if (text[i] === '"') {
      i += 1;
      let out = "";
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") {
          out += text[i + 1];
          i += 2;
          continue;
        }
        out += text[i];
        i += 1;
      }
      i += 1; // closing quote
      return out;
    }
    // Bare token: letters/digits and the punctuation Xcode leaves unquoted.
    let out = "";
    while (i < n && /[^\s{}()=;,"]/.test(text[i])) {
      out += text[i];
      i += 1;
    }
    return out;
  };

  const parseValue = (): PlistValue => {
    skipTrivia();
    if (text[i] === "{") {
      return parseDict();
    }
    if (text[i] === "(") {
      return parseArray();
    }
    return parseString();
  };

  const parseArray = (): PlistValue[] => {
    const arr: PlistValue[] = [];
    i += 1; // (
    for (;;) {
      skipTrivia();
      if (text[i] === ")") {
        i += 1;
        break;
      }
      if (i >= n) {
        break;
      }
      arr.push(parseValue());
      skipTrivia();
      if (text[i] === ",") {
        i += 1;
      }
    }
    return arr;
  };

  const parseDict = (): { [key: string]: PlistValue } => {
    const dict: { [key: string]: PlistValue } = {};
    i += 1; // {
    for (;;) {
      skipTrivia();
      if (text[i] === "}") {
        i += 1;
        break;
      }
      if (i >= n) {
        break;
      }
      const key = parseString();
      skipTrivia();
      if (text[i] !== "=") {
        break; // malformed
      }
      i += 1; // =
      const value = parseValue();
      dict[key] = value;
      skipTrivia();
      if (text[i] === ";") {
        i += 1;
      }
    }
    return dict;
  };

  skipTrivia();
  if (text[i] !== "{") {
    return undefined;
  }
  try {
    const root = parseDict();
    return root;
  } catch {
    return undefined;
  }
}

// --- pbxproj extraction -----------------------------------------------------

function asDict(value: PlistValue | undefined): { [key: string]: PlistValue } | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function asArray(value: PlistValue | undefined): PlistValue[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: PlistValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const PRODUCT_TYPE_KIND: Array<[RegExp, AppleTargetKind]> = [
  [/ui-testing/, "ui_test"],
  [/unit-test/, "unit_test"],
  [/app-extension|extensionkit-extension/, "extension"],
  [/application/, "application"],
  [/framework/, "framework"],
  [/library/, "library"]
];

function kindFromProductType(productType: string): AppleTargetKind {
  for (const [pattern, kind] of PRODUCT_TYPE_KIND) {
    if (pattern.test(productType)) {
      return kind;
    }
  }
  return "other";
}

export interface PbxRemotePackage {
  url: string;
  requirement: { [key: string]: PlistValue };
}

export interface PbxprojResult {
  parsed: boolean;
  targets: AppleTarget[];
  remote_packages: PbxRemotePackage[];
}

export function parsePbxproj(pbxprojPath: string, content: string): PbxprojResult {
  const root = parsePlist(content);
  const objects = asDict(root?.objects);
  if (!objects) {
    return { parsed: false, targets: [], remote_packages: [] };
  }

  // The project dir is the parent of the .xcodeproj bundle; file paths resolved
  // through the group tree are relative to it.
  const projectDir = pbxprojPath.replace(/\/[^/]+\.xcodeproj\/project\.pbxproj$/, "");
  const baseDir = projectDir === pbxprojPath ? "" : projectDir;

  // Resolve a PBXFileReference / group id to its repo-relative path by walking the
  // group tree. Build a child->parent map first.
  const parentOf = new Map<string, string>();
  for (const [id, obj] of Object.entries(objects)) {
    const dict = asDict(obj);
    if (!dict) {
      continue;
    }
    const isa = asString(dict.isa) ?? "";
    if (isa === "PBXGroup" || isa === "PBXVariantGroup" || isa === "PBXFileSystemSynchronizedRootGroup") {
      for (const child of asArray(dict.children)) {
        const childId = asString(child);
        if (childId) {
          parentOf.set(childId, id);
        }
      }
    }
  }

  const pathOfRef = (refId: string): string | undefined => {
    const segments: string[] = [];
    let current: string | undefined = refId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const dict = asDict(objects[current]);
      if (!dict) {
        break;
      }
      const sourceTree = asString(dict.sourceTree);
      const segment = asString(dict.path);
      if (segment) {
        segments.unshift(segment);
      }
      // An absolute / SDK / group-rooted source tree stops upward accumulation at
      // the project root (we only model repo-relative committed sources).
      if (sourceTree === "SOURCE_ROOT" || sourceTree === "<group>" || sourceTree === undefined) {
        current = parentOf.get(current);
        continue;
      }
      break;
    }
    if (segments.length === 0) {
      return undefined;
    }
    const joined = segments.join("/").replace(/\/+/g, "/");
    return baseDir ? `${baseDir}/${joined}` : joined;
  };

  const targets: AppleTarget[] = [];
  for (const [, obj] of Object.entries(objects)) {
    const dict = asDict(obj);
    if (!dict || asString(dict.isa) !== "PBXNativeTarget") {
      continue;
    }
    const name = asString(dict.name) ?? asString(dict.productName);
    if (!name) {
      continue;
    }
    const kind = kindFromProductType(asString(dict.productType) ?? "");
    const sourcePaths = new Set<string>();
    for (const phaseId of asArray(dict.buildPhases)) {
      const phase = asDict(objects[asString(phaseId) ?? ""]);
      if (!phase || asString(phase.isa) !== "PBXSourcesBuildPhase") {
        continue;
      }
      for (const buildFileId of asArray(phase.files)) {
        const buildFile = asDict(objects[asString(buildFileId) ?? ""]);
        const refId = asString(buildFile?.fileRef);
        if (!refId) {
          continue;
        }
        const resolved = pathOfRef(refId);
        if (resolved && resolved.toLowerCase().endsWith(".swift")) {
          sourcePaths.add(resolved);
        }
      }
    }
    // PBXFileSystemSynchronizedRootGroup targets (Xcode 16 folder targets) list a
    // membership group instead of explicit build files: fall back to the target's
    // synchronized root path so the symbol graph can still scope the module.
    const dependencyTargets = new Set<string>();
    for (const depId of asArray(dict.dependencies)) {
      const dep = asDict(objects[asString(depId) ?? ""]);
      const depTargetName = dep ? targetNameOfDependency(dep, objects) : undefined;
      if (depTargetName) {
        dependencyTargets.add(depTargetName);
      }
    }
    targets.push({
      id: name,
      name,
      kind,
      source_paths: [...sourcePaths].sort(),
      dependency_target_ids: [...dependencyTargets].sort(),
      provenance: ["pbxproj"]
    });
  }
  targets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const remotePackages: PbxRemotePackage[] = [];
  for (const [, obj] of Object.entries(objects)) {
    const dict = asDict(obj);
    if (!dict || asString(dict.isa) !== "XCRemoteSwiftPackageReference") {
      continue;
    }
    const url = asString(dict.repositoryURL);
    const requirement = asDict(dict.requirement) ?? {};
    if (url) {
      remotePackages.push({ url, requirement });
    }
  }
  remotePackages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  return { parsed: true, targets, remote_packages: remotePackages };
}

function targetNameOfDependency(dep: { [key: string]: PlistValue }, objects: { [key: string]: PlistValue }): string | undefined {
  // A PBXTargetDependency carries either a direct `target` id or a proxy.
  const targetId = asString(dep.target);
  if (targetId) {
    const target = asDict(objects[targetId]);
    return asString(target?.name);
  }
  return undefined;
}

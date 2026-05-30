import fs from "node:fs";
import path from "node:path";
import { ChangedFile } from "../collector/git";
import { toPosixPath } from "../core/files";

// TRD section 10.2: classify changed files, detect language + ecosystem,
// and expose deterministic structural clusters the LLM may label but not invent.

export type FileClassification =
  | "source"
  | "test"
  | "docs"
  | "config"
  | "generated"
  | "lockfile"
  | "unknown";

export type FileLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "json"
  | "yaml"
  | "markdown"
  | "shell"
  | "other";

export interface IndexedFile {
  path: string;
  classification: FileClassification;
  language: FileLanguage;
}

export type EcosystemId = "node" | "python" | "go" | "rust";

export interface Ecosystem {
  id: EcosystemId;
  evidence: string;
}

export interface RepoCluster {
  id: string;
  label: string;
  files: string[];
  dirs: string[];
  language: FileLanguage;
}

export interface RepoIndex {
  files: IndexedFile[];
  ecosystems: Ecosystem[];
  clusters: RepoCluster[];
}

export interface BuildRepoIndexOptions {
  cwd: string;
  changedFiles: ChangedFile[];
  repositoryFiles: string[];
}

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "go.sum"
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".cs"
]);

const TS_JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function classifyFile(filePath: string): FileClassification {
  const posix = toPosixPath(filePath);
  const base = baseName(posix);
  const lower = posix.toLowerCase();
  const lowerBase = base.toLowerCase();

  if (LOCKFILES.has(base)) {
    return "lockfile";
  }
  if (isGenerated(lower, lowerBase)) {
    return "generated";
  }
  if (isTest(lower, lowerBase)) {
    return "test";
  }
  if (isDocs(lower, lowerBase)) {
    return "docs";
  }
  if (isConfig(lower, lowerBase)) {
    return "config";
  }
  if (SOURCE_EXTENSIONS.has(extName(lowerBase))) {
    return "source";
  }
  return "unknown";
}

export function detectLanguage(filePath: string): FileLanguage {
  const base = baseName(toPosixPath(filePath)).toLowerCase();
  const ext = extName(base);
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell";
    default:
      return "other";
  }
}

export function buildRepoIndex(options: BuildRepoIndexOptions): RepoIndex {
  const files = buildFiles(options.changedFiles);
  const ecosystems = detectEcosystems(options.repositoryFiles);
  const clusters = buildClusters(options.cwd, files);
  return { files, ecosystems, clusters };
}

function buildFiles(changedFiles: ChangedFile[]): IndexedFile[] {
  return changedFiles
    .map((changed) => {
      const posix = toPosixPath(changed.path);
      return {
        path: posix,
        classification: classifyFile(posix),
        language: detectLanguage(posix)
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function detectEcosystems(repositoryFiles: string[]): Ecosystem[] {
  const present = new Set(repositoryFiles.map((file) => toPosixPath(file)));
  const ecosystems: Ecosystem[] = [];
  const seen = new Set<EcosystemId>();

  const add = (id: EcosystemId, evidence: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ecosystems.push({ id, evidence });
    }
  };

  const findManifest = (candidates: string[]): string | undefined => {
    const matches = [...present].filter((file) => candidates.includes(baseName(file)));
    matches.sort((left, right) => left.localeCompare(right));
    return matches[0];
  };

  const node = findManifest(["package.json"]);
  if (node) {
    add("node", node);
  }
  const python = findManifest(["pyproject.toml", "requirements.txt"]);
  if (python) {
    add("python", python);
  }
  const go = findManifest(["go.mod"]);
  if (go) {
    add("go", go);
  }
  const rust = findManifest(["Cargo.toml"]);
  if (rust) {
    add("rust", rust);
  }

  return ecosystems.sort((left, right) => left.id.localeCompare(right.id));
}

interface MutableCluster {
  dirs: Set<string>;
  files: Set<string>;
  languages: Map<FileLanguage, number>;
}

function buildClusters(cwd: string, files: IndexedFile[]): RepoCluster[] {
  // Cluster only changed source and test files; docs/config/lockfiles/generated
  // are not structural code surfaces.
  const clusterable = files.filter(
    (file) => file.classification === "source" || file.classification === "test"
  );
  if (clusterable.length === 0) {
    return [];
  }

  // Step 1: directory-based grouping. Each meaningful directory prefix is a seed.
  const dirToFiles = new Map<string, IndexedFile[]>();
  for (const file of clusterable) {
    const dir = clusterDir(file.path);
    const bucket = dirToFiles.get(dir);
    if (bucket) {
      bucket.push(file);
    } else {
      dirToFiles.set(dir, [file]);
    }
  }

  // Union-find over directory seeds so import adjacency can merge them.
  const dirs = [...dirToFiles.keys()].sort((left, right) => left.localeCompare(right));
  const parent = new Map<string, string>();
  for (const dir of dirs) {
    parent.set(dir, dir);
  }
  const find = (dir: string): string => {
    let root = dir;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    let cursor = dir;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (left: string, right: string): void => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft === rootRight) {
      return;
    }
    // Keep the lexicographically smaller root for deterministic ids.
    if (rootLeft.localeCompare(rootRight) <= 0) {
      parent.set(rootRight, rootLeft);
    } else {
      parent.set(rootLeft, rootRight);
    }
  };

  // Step 2: bounded import enrichment for TS/JS. Only changed files and their
  // DIRECT relative imports are considered (no transitive expansion).
  const fileSet = new Set(clusterable.map((file) => file.path));
  const dirOfFile = new Map<string, string>();
  for (const [dir, bucket] of dirToFiles) {
    for (const file of bucket) {
      dirOfFile.set(file.path, dir);
    }
  }

  for (const file of clusterable) {
    if (file.language !== "typescript" && file.language !== "javascript") {
      continue;
    }
    const fromDir = dirOfFile.get(file.path);
    if (!fromDir) {
      continue;
    }
    const specifiers = extractRelativeImports(cwd, file.path);
    for (const specifier of specifiers) {
      const target = resolveRelativeImport(file.path, specifier, fileSet);
      if (!target) {
        continue;
      }
      const targetDir = dirOfFile.get(target);
      if (targetDir && targetDir !== fromDir) {
        union(fromDir, targetDir);
      }
    }
  }

  // Step 3: collapse directory seeds into merged clusters.
  const merged = new Map<string, MutableCluster>();
  for (const [dir, bucket] of dirToFiles) {
    const root = find(dir);
    let cluster = merged.get(root);
    if (!cluster) {
      cluster = { dirs: new Set(), files: new Set(), languages: new Map() };
      merged.set(root, cluster);
    }
    cluster.dirs.add(dir);
    for (const file of bucket) {
      cluster.files.add(file.path);
      cluster.languages.set(file.language, (cluster.languages.get(file.language) ?? 0) + 1);
    }
  }

  const clusters: RepoCluster[] = [...merged.entries()].map(([root, cluster]) => {
    const sortedDirs = [...cluster.dirs].sort((left, right) => left.localeCompare(right));
    const sortedFiles = [...cluster.files].sort((left, right) => left.localeCompare(right));
    return {
      id: `cluster:${root}`,
      label: clusterLabel(sortedDirs),
      files: sortedFiles,
      dirs: sortedDirs,
      language: dominantLanguage(cluster.languages)
    };
  });

  return clusters.sort((left, right) => left.id.localeCompare(right.id));
}

function clusterDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  if (idx < 0) {
    return ".";
  }
  return filePath.slice(0, idx);
}

function clusterLabel(dirs: string[]): string {
  if (dirs.length === 1) {
    return dirs[0] === "." ? "(root)" : dirs[0];
  }
  return dirs.map((dir) => (dir === "." ? "(root)" : dir)).join(", ");
}

function dominantLanguage(languages: Map<FileLanguage, number>): FileLanguage {
  let best: FileLanguage = "other";
  let bestCount = -1;
  // Iterate in deterministic language order so ties resolve stably.
  const ordered = [...languages.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
  for (const [language, count] of ordered) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}

const RELATIVE_IMPORT_PATTERNS = [
  /\bimport\b[^;'"]*?\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g,
  /\bimport\s*['"](\.\.?\/[^'"]+)['"]/g,
  /\bexport\b[^;'"]*?\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g,
  /\brequire\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g
];

function extractRelativeImports(cwd: string, relativePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(path.resolve(cwd, relativePath), "utf8");
  } catch {
    return [];
  }
  const specifiers = new Set<string>();
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  return [...specifiers].sort((left, right) => left.localeCompare(right));
}

function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  fileSet: Set<string>
): string | undefined {
  const fromDir = clusterDir(fromPath);
  const base = fromDir === "." ? specifier : `${fromDir}/${specifier}`;
  const normalized = normalizePosix(base);

  const candidates: string[] = [normalized];
  for (const ext of TS_JS_EXTENSIONS) {
    candidates.push(`${normalized}${ext}`);
    candidates.push(`${normalized}/index${ext}`);
  }
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function normalizePosix(p: string): string {
  const segments = p.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else {
        stack.push(segment);
      }
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

function isTest(lower: string, lowerBase: string): boolean {
  if (/\.(test|spec)\.[^.]+$/.test(lowerBase)) {
    return true;
  }
  return lower.startsWith("tests/") || lower.startsWith("test/") || lower.includes("/tests/") || lower.includes("/test/");
}

function isDocs(lower: string, lowerBase: string): boolean {
  if (lowerBase.endsWith(".md") || lowerBase.endsWith(".markdown")) {
    return true;
  }
  return lower.startsWith("docs/") || lower.includes("/docs/");
}

function isConfig(lower: string, lowerBase: string): boolean {
  if (lowerBase === "package.json") {
    return true;
  }
  if (lowerBase.startsWith("tsconfig") && lowerBase.endsWith(".json")) {
    return true;
  }
  // dotfile rc configs like .eslintrc, .prettierrc, .babelrc(.json)
  if (/^\.[^.]+rc(\.[^.]+)?$/.test(lowerBase)) {
    return true;
  }
  // *.config.* (e.g. vite.config.ts, jest.config.js)
  if (/\.config\.[^.]+$/.test(lowerBase)) {
    return true;
  }
  const ext = extName(lowerBase);
  return ext === ".yaml" || ext === ".yml" || ext === ".toml" || ext === ".ini";
}

function isGenerated(lower: string, lowerBase: string): boolean {
  if (/\.min\.[^.]+$/.test(lowerBase)) {
    return true;
  }
  return (
    lower.startsWith("dist/") ||
    lower.startsWith("build/") ||
    lower.startsWith("generated/") ||
    lower.includes("/dist/") ||
    lower.includes("/build/") ||
    lower.includes("/generated/")
  );
}

function baseName(posixPath: string): string {
  const idx = posixPath.lastIndexOf("/");
  return idx < 0 ? posixPath : posixPath.slice(idx + 1);
}

function extName(base: string): string {
  const idx = base.lastIndexOf(".");
  if (idx <= 0) {
    return "";
  }
  return base.slice(idx);
}

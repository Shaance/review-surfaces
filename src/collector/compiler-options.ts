import path from "node:path";
import ts from "typescript";
import { resolveRuntimeRelativeImports } from "./import-graph";

export function createRuntimeImportResolver(
  read: (filePath: string) => string | undefined,
  cwd: string,
  options: {
    reviewedPaths?: ReadonlySet<string>;
    isIgnored?: (filePath: string) => boolean;
  } = {}
): typeof resolveRuntimeRelativeImports {
  const importCache = new Map<string, string[]>();
  const directoryOptions = new Map<string, ts.CompilerOptions>();
  const rawConfigs = new Map<string, string | undefined>();
  const resolvedConfigs = new Map<string, Record<string, unknown>>();
  const extendsPaths = new Map<string, string | undefined>();

  const rawConfig = (configPath: string): string | undefined => {
    if (rawConfigs.has(configPath)) return rawConfigs.get(configPath);
    const raw = options.isIgnored?.(configPath) || (options.reviewedPaths && !options.reviewedPaths.has(configPath))
      ? undefined
      : read(configPath);
    rawConfigs.set(configPath, raw);
    return raw;
  };

  const configCandidates = (base: string): string[] => base.endsWith(".json")
    ? [base]
    : [base, `${base}.json`, `${base}/tsconfig.json`];

  const firstReadableConfig = (candidates: string[]): string | undefined =>
    candidates.find((candidate) => rawConfig(candidate) !== undefined);

  const resolveExtendsPath = (configPath: string, entry: string): string | undefined => {
    const cacheKey = `${configPath}\0${entry}`;
    if (extendsPaths.has(cacheKey)) return extendsPaths.get(cacheKey);
    let resolved: string | undefined;
    if (entry.startsWith(".")) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(configPath), entry));
      resolved = firstReadableConfig(configCandidates(base)) ?? configCandidates(base)[1] ?? base;
    } else if (path.isAbsolute(entry)) {
      const relative = path.relative(cwd, entry).replace(/\\/g, "/");
      if (relative !== "" && !relative.startsWith("../") && !path.isAbsolute(relative)) {
        resolved = firstReadableConfig(configCandidates(path.posix.normalize(relative)));
      }
    } else if (!/^[A-Za-z]:[\\/]/u.test(entry) && !entry.startsWith("\\\\")) {
      let directory = path.posix.dirname(configPath);
      while (true) {
        const prefix = directory === "." ? "" : `${directory}/`;
        resolved = firstReadableConfig(configCandidates(`${prefix}node_modules/${entry}`));
        if (resolved) break;
        if (directory === "." || directory === "") break;
        const parent = path.posix.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    extendsPaths.set(cacheKey, resolved);
    return resolved;
  };

  const resolveConfig = (configPath: string, seen = new Set<string>()): Record<string, unknown> => {
    const cached = resolvedConfigs.get(configPath);
    if (cached) return cached;
    if (seen.has(configPath)) return {};
    seen.add(configPath);
    const raw = rawConfig(configPath);
    if (!raw) {
      resolvedConfigs.set(configPath, {});
      return {};
    }
    try {
      const parsed = ts.parseConfigFileTextToJson(configPath, raw);
      if (parsed.error || !parsed.config) {
        resolvedConfigs.set(configPath, {});
        return {};
      }
      const config = parsed.config as { extends?: unknown; compilerOptions?: unknown };
      let inherited: Record<string, unknown> = {};
      const bases = (Array.isArray(config.extends) ? config.extends : [config.extends])
        .filter((entry): entry is string => typeof entry === "string");
      for (const entry of bases) {
        const base = resolveExtendsPath(configPath, entry);
        if (!base) continue;
        inherited = {
          ...inherited,
          ...resolveConfig(base, new Set(seen))
        };
      }
      const own = config.compilerOptions && typeof config.compilerOptions === "object"
        ? config.compilerOptions as Record<string, unknown>
        : {};
      const resolved = { ...inherited, ...own };
      resolvedConfigs.set(configPath, resolved);
      return resolved;
    } catch {
      resolvedConfigs.set(configPath, {});
      return {};
    }
  };

  const optionsForDirectory = (directory: string): ts.CompilerOptions => {
    const normalized = directory === "." ? "" : directory;
    const cached = directoryOptions.get(normalized);
    if (cached) return cached;
    const configPath = normalized ? `${normalized}/tsconfig.json` : "tsconfig.json";
    const options = rawConfig(configPath) !== undefined
      ? ts.convertCompilerOptionsFromJson(resolveConfig(configPath), cwd).options
      : normalized
        ? optionsForDirectory(path.posix.dirname(normalized))
        : {};
    directoryOptions.set(normalized, options);
    return options;
  };

  return (sourcePath, content, exists): string[] => {
    const cached = importCache.get(sourcePath);
    if (cached) return cached;
    const imports = resolveRuntimeRelativeImports(
      sourcePath,
      content,
      exists,
      optionsForDirectory(path.posix.dirname(sourcePath))
    );
    importCache.set(sourcePath, imports);
    return imports;
  };
}

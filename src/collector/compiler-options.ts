import path from "node:path";
import ts from "typescript";
import { resolveRuntimeRelativeImports } from "./import-graph";

export function createRuntimeImportResolver(
  read: (filePath: string) => string | undefined,
  cwd: string
): typeof resolveRuntimeRelativeImports {
  const importCache = new Map<string, string[]>();
  const directoryOptions = new Map<string, ts.CompilerOptions>();
  const rawConfigs = new Map<string, string | undefined>();
  const resolvedConfigs = new Map<string, Record<string, unknown>>();

  const rawConfig = (configPath: string): string | undefined => {
    if (rawConfigs.has(configPath)) return rawConfigs.get(configPath);
    const raw = read(configPath);
    rawConfigs.set(configPath, raw);
    return raw;
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
        .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("."));
      for (const entry of bases) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(configPath), entry));
        inherited = {
          ...inherited,
          ...resolveConfig(base.endsWith(".json") ? base : `${base}.json`, new Set(seen))
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

/**
 * Conservative, deterministic contract-surface classification shared by
 * semantic review consumers. Unknown TypeScript exports stay internal; only
 * persisted schemas/declarations and conventional package/CLI entry points are
 * treated as consumer-facing without package-graph proof.
 */
export function isExplicitContractSurfacePath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, "").toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;
  return normalized.endsWith(".d.ts") ||
    /(^|\/)schemas?\//.test(normalized) ||
    (normalized.endsWith(".json") && /schema/i.test(name));
}

export function isPersistedSchemaPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, "").toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;
  return /(^|\/)schemas?\//.test(normalized) ||
    (normalized.endsWith(".json") && /schema/i.test(name));
}

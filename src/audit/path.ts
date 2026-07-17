export function repositoryPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const parsed = value.trim();
  if (parsed.startsWith("/") || parsed.includes("\\") || /^[A-Za-z]:/u.test(parsed) ||
    /[\0\r\n]/u.test(parsed) || parsed.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return parsed;
}

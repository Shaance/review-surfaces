// review-surfaces.CONFIG_FACTS.1-3: small, independent, deterministic detectors
// for env-var, CI-workflow, Dockerfile, and SQL/migration changes. Regex
// altitude is deliberate (CONFIG_FACTS.3): these flag changes FOR HUMAN
// ATTENTION — the fact language says so — they do not prove semantics. Facts
// route into existing lenses (security_privacy), never new surfaces.
import { parse as parseYaml } from "yaml";
import { StructuredDiff, StructuredDiffFile } from "../pr/contract";

export type ConfigFactKind =
  | "env_var_added"
  | "env_var_removed"
  | "env_example_key_change"
  | "ci_permissions_broadened"
  | "ci_new_secret_reference"
  | "ci_pull_request_target_added"
  | "ci_unpinned_action"
  | "docker_curl_pipe_shell"
  | "docker_base_image_changed"
  | "docker_user_dropped"
  | "sql_destructive_statement";

export interface ConfigFact {
  kind: ConfigFactKind;
  path: string;
  line?: number;
  detail: string;
}

export interface ComputeConfigFactsInput {
  diff: StructuredDiff;
  readBase: (filePath: string) => string | undefined;
  readHead: (filePath: string) => string | undefined;
}

export function computeConfigFacts(input: ComputeConfigFactsInput): ConfigFact[] {
  const facts: ConfigFact[] = [];
  for (const file of input.diff.files) {
    if (isWorkflowPath(file.path)) {
      facts.push(...workflowFacts(file, input));
    } else if (isDockerfilePath(file.path)) {
      facts.push(...dockerfileFacts(file, input));
    } else if (isSqlPath(file.path)) {
      facts.push(...sqlFacts(file));
    } else if (isEnvExamplePath(file.path)) {
      facts.push(...envExampleFacts(file));
    } else if (isCodePath(file.path)) {
      facts.push(...envReferenceFacts(file));
    }
  }
  facts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.kind < b.kind ? -1 : 1) || (a.detail < b.detail ? -1 : 1));
  return facts;
}

function addedLines(file: StructuredDiffFile): Array<{ text: string; line?: number }> {
  return file.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line.kind === "add").map((line) => ({ text: line.text, line: line.new_line }))
  );
}

function removedLines(file: StructuredDiffFile): string[] {
  return file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "delete").map((line) => line.text));
}

function isWorkflowPath(p: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);
}
function isDockerfilePath(p: string): boolean {
  return /(^|\/)Dockerfile([._-][\w.-]+)?$/i.test(p) || /\.dockerfile$/i.test(p);
}
function isSqlPath(p: string): boolean {
  return /\.sql$/i.test(p) || /(^|\/)migrations?\//i.test(p);
}
function isEnvExamplePath(p: string): boolean {
  return /(^|\/)\.env(\.[\w.-]+)?$/i.test(p);
}
function isCodePath(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p);
}

// --- env vars (CONFIG_FACTS.1) ----------------------------------------------

const ENV_REF = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g;

function envReferenceFacts(file: StructuredDiffFile): ConfigFact[] {
  const removedVars = new Set<string>();
  for (const text of removedLines(file)) {
    for (const match of text.matchAll(ENV_REF)) {
      removedVars.add(match[1] ?? match[2]);
    }
  }
  const facts: ConfigFact[] = [];
  const seenAdded = new Set<string>();
  for (const { text, line } of addedLines(file)) {
    for (const match of text.matchAll(ENV_REF)) {
      const name = match[1] ?? match[2];
      if (removedVars.has(name) || seenAdded.has(name)) {
        removedVars.delete(name); // moved, not introduced
        continue;
      }
      seenAdded.add(name);
      facts.push({
        kind: "env_var_added",
        path: file.path,
        line,
        detail: `introduces a reference to env var \`${name}\` — confirm it is documented and has a default or failure mode`
      });
    }
  }
  for (const name of [...removedVars].sort()) {
    facts.push({
      kind: "env_var_removed",
      path: file.path,
      detail: `removes the last changed reference to env var \`${name}\` in this file — confirm nothing still sets or expects it`
    });
  }
  return facts;
}

function envExampleFacts(file: StructuredDiffFile): ConfigFact[] {
  const keyOf = (text: string): string | undefined => text.match(/^([A-Z][A-Z0-9_]*)\s*=/)?.[1];
  const added = new Set(addedLines(file).map(({ text }) => keyOf(text)).filter((k): k is string => Boolean(k)));
  const removed = new Set(removedLines(file).map(keyOf).filter((k): k is string => Boolean(k)));
  const facts: ConfigFact[] = [];
  for (const key of [...added].sort()) {
    if (!removed.has(key)) {
      facts.push({ kind: "env_example_key_change", path: file.path, detail: `adds env example key \`${key}\`` });
    }
  }
  for (const key of [...removed].sort()) {
    if (!added.has(key)) {
      facts.push({ kind: "env_example_key_change", path: file.path, detail: `removes env example key \`${key}\`` });
    }
  }
  return facts;
}

// --- CI workflows (CONFIG_FACTS.2) -------------------------------------------

const WRITE_PERMISSIONS = new Set(["write", "write-all"]);

function workflowFacts(file: StructuredDiffFile, input: ComputeConfigFactsInput): ConfigFact[] {
  const facts: ConfigFact[] = [];
  const basePermissions = workflowWritePermissions(input.readBase(file.old_path ?? file.path));
  const headPermissions = workflowWritePermissions(input.readHead(file.path));
  for (const permission of [...headPermissions].sort()) {
    if (!basePermissions.has(permission)) {
      facts.push({
        kind: "ci_permissions_broadened",
        path: file.path,
        detail: `broadens workflow permissions: \`${permission}\` — flagged for attention, not proven exploitable`
      });
    }
  }
  for (const { text, line } of addedLines(file)) {
    for (const match of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      if (match[1] !== "GITHUB_TOKEN") {
        facts.push({
          kind: "ci_new_secret_reference",
          path: file.path,
          line,
          detail: `adds a reference to secret \`${match[1]}\``
        });
      }
    }
    if (/^\s*pull_request_target\s*:/.test(text)) {
      facts.push({
        kind: "ci_pull_request_target_added",
        path: file.path,
        line,
        detail: "adds a pull_request_target trigger — PR-controlled code must never reach secret-bearing steps"
      });
    }
    const uses = text.match(/uses:\s*([\w.-]+\/[\w./-]+)@([\w.-]+)/);
    if (uses && !uses[1].startsWith("actions/") && !uses[1].startsWith("./") && !/^[0-9a-f]{40}$/.test(uses[2])) {
      facts.push({
        kind: "ci_unpinned_action",
        path: file.path,
        line,
        detail: `uses third-party action \`${uses[1]}@${uses[2]}\` not pinned to a commit SHA`
      });
    }
  }
  return facts;
}

function workflowWritePermissions(text: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!text) {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return result;
  }
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    const record = node as Record<string, unknown>;
    const permissions = record.permissions;
    if (typeof permissions === "string" && WRITE_PERMISSIONS.has(permissions)) {
      result.add(permissions);
    } else if (typeof permissions === "object" && permissions !== null) {
      for (const [scope, level] of Object.entries(permissions as Record<string, unknown>)) {
        if (typeof level === "string" && WRITE_PERMISSIONS.has(level)) {
          result.add(`${scope}: ${level}`);
        }
      }
    }
    for (const value of Object.values(record)) {
      visit(value);
    }
  };
  visit(parsed);
  return result;
}

// --- Dockerfiles (CONFIG_FACTS.3) ---------------------------------------------

function dockerfileFacts(file: StructuredDiffFile, input: ComputeConfigFactsInput): ConfigFact[] {
  const facts: ConfigFact[] = [];
  for (const { text, line } of addedLines(file)) {
    if (/^\s*RUN\b.*\b(curl|wget)\b.*\|\s*(ba|z|da)?sh\b/i.test(text)) {
      facts.push({
        kind: "docker_curl_pipe_shell",
        path: file.path,
        line,
        detail: "adds a RUN that pipes a download into a shell — flagged for attention, not proven malicious"
      });
    }
    if (/^\s*FROM\s+\S+/i.test(text)) {
      facts.push({ kind: "docker_base_image_changed", path: file.path, line, detail: `changes/adds base image: \`${text.trim()}\`` });
    }
  }
  const baseHasUser = /^\s*USER\s+\S+/im.test(input.readBase(file.old_path ?? file.path) ?? "");
  const headHasUser = /^\s*USER\s+\S+/im.test(input.readHead(file.path) ?? "");
  if (baseHasUser && !headHasUser) {
    facts.push({ kind: "docker_user_dropped", path: file.path, detail: "drops the USER directive — the container now runs as root" });
  }
  return facts;
}

// --- SQL / migrations (CONFIG_FACTS.3) -----------------------------------------

const DESTRUCTIVE_SQL = [
  { pattern: /\bDROP\s+TABLE\b/i, label: "DROP TABLE" },
  { pattern: /\bDROP\s+COLUMN\b/i, label: "DROP COLUMN" },
  { pattern: /\bALTER\s+(TABLE\s+\S+\s+)?.*\bTYPE\b/i, label: "ALTER ... TYPE" },
  { pattern: /\bTRUNCATE\b/i, label: "TRUNCATE" },
  { pattern: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i, label: "DELETE without WHERE" }
];

function sqlFacts(file: StructuredDiffFile): ConfigFact[] {
  const facts: ConfigFact[] = [];
  for (const { text, line } of addedLines(file)) {
    for (const { pattern, label } of DESTRUCTIVE_SQL) {
      if (pattern.test(text)) {
        facts.push({
          kind: "sql_destructive_statement",
          path: file.path,
          line,
          detail: `adds a destructive SQL statement (${label}) — flagged for human attention, not proven unsafe`
        });
        break;
      }
    }
  }
  return facts;
}

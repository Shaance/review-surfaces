type YamlRecord = Record<string, unknown>;

interface KeyValue {
  key: string;
  value: string;
}

export function parseYaml(text: string): unknown {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  function skipBlank(): void {
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        return;
      }
      index += 1;
    }
  }

  function parseBlock(indent: number): unknown {
    skipBlank();
    if (index >= lines.length) {
      return {};
    }

    const currentIndent = indentOf(lines[index]);
    if (currentIndent < indent) {
      return {};
    }

    if (lines[index].trimStart().startsWith("- ")) {
      return parseArray(currentIndent);
    }

    return parseObject(currentIndent);
  }

  function parseObject(indent: number): YamlRecord {
    const result: YamlRecord = {};

    while (index < lines.length) {
      skipBlank();
      if (index >= lines.length) {
        break;
      }

      const raw = lines[index];
      const currentIndent = indentOf(raw);
      const trimmed = raw.trim();
      if (currentIndent < indent || trimmed.startsWith("- ")) {
        break;
      }
      if (currentIndent > indent) {
        throw new Error(`Unexpected indentation at line ${index + 1}`);
      }

      const keyValue = splitKeyValue(trimmed);
      if (!keyValue) {
        throw new Error(`Expected key/value pair at line ${index + 1}`);
      }

      index += 1;
      result[keyValue.key] = parseValueAfterKey(keyValue, currentIndent);
    }

    return result;
  }

  function parseArray(indent: number): unknown[] {
    const result: unknown[] = [];

    while (index < lines.length) {
      skipBlank();
      if (index >= lines.length) {
        break;
      }

      const raw = lines[index];
      const currentIndent = indentOf(raw);
      const trimmed = raw.trim();
      if (currentIndent < indent || !trimmed.startsWith("- ")) {
        break;
      }
      if (currentIndent > indent) {
        throw new Error(`Unexpected list indentation at line ${index + 1}`);
      }

      const rest = trimmed.slice(2).trim();
      index += 1;
      if (rest === "") {
        skipBlank();
        result.push(index < lines.length ? parseBlock(indentOf(lines[index])) : {});
        continue;
      }

      const inlineKeyValue = splitKeyValue(rest);
      if (inlineKeyValue) {
        const item: YamlRecord = {};
        item[inlineKeyValue.key] = parseValueAfterKey(inlineKeyValue, currentIndent);
        mergeFollowingObjectLines(item, currentIndent + 2);
        result.push(item);
      } else {
        result.push(parseScalar(rest));
      }
    }

    return result;
  }

  function mergeFollowingObjectLines(target: YamlRecord, indent: number): void {
    skipBlank();
    while (index < lines.length) {
      const currentIndent = indentOf(lines[index]);
      if (currentIndent < indent || lines[index].trimStart().startsWith("- ")) {
        return;
      }

      const parsed = parseObject(currentIndent);
      for (const key of Object.keys(parsed)) {
        target[key] = parsed[key];
      }
      skipBlank();
    }
  }

  function parseValueAfterKey(keyValue: KeyValue, parentIndent: number): unknown {
    if (keyValue.value === "|") {
      return readBlockScalar(parentIndent);
    }

    if (keyValue.value !== "") {
      return parseScalar(keyValue.value);
    }

    skipBlank();
    if (index >= lines.length || indentOf(lines[index]) <= parentIndent) {
      return {};
    }
    return parseBlock(indentOf(lines[index]));
  }

  function readBlockScalar(parentIndent: number): string {
    const blockLines: string[] = [];
    const contentIndent = parentIndent + 2;

    while (index < lines.length) {
      const raw = lines[index];
      if (raw.trim() !== "" && indentOf(raw) <= parentIndent) {
        break;
      }

      if (raw.trim() === "") {
        blockLines.push("");
      } else {
        blockLines.push(raw.slice(Math.min(contentIndent, raw.length)));
      }
      index += 1;
    }

    return blockLines.join("\n").replace(/\n+$/, "");
  }

  return parseBlock(0);
}

export function stringifyYaml(value: unknown, indent = 0): string {
  const lines = stringifyYamlLines(value, indent);
  return `${lines.join("\n")}\n`;
}

function stringifyYamlLines(value: unknown, indent: number): string[] {
  const prefix = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${prefix}[]`];
    }

    const lines: string[] = [];
    for (const item of value) {
      if (isRecord(item)) {
        const itemLines = stringifyYamlLines(item, indent + 2);
        lines.push(`${prefix}- ${itemLines[0].trimStart()}`);
        for (const extraLine of itemLines.slice(1)) {
          lines.push(extraLine);
        }
      } else {
        lines.push(`${prefix}- ${formatScalar(item)}`);
      }
    }
    return lines;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [`${prefix}{}`];
    }

    const lines: string[] = [];
    for (const [key, nested] of entries) {
      if (isRecord(nested) || Array.isArray(nested)) {
        const nestedLines = stringifyYamlLines(nested, indent + 2);
        lines.push(`${prefix}${key}:`);
        lines.push(...nestedLines);
      } else if (typeof nested === "string" && nested.includes("\n")) {
        lines.push(`${prefix}${key}: |`);
        for (const blockLine of nested.split("\n")) {
          lines.push(`${prefix}  ${blockLine}`);
        }
      } else {
        lines.push(`${prefix}${key}: ${formatScalar(nested)}`);
      }
    }
    return lines;
  }

  return [`${prefix}${formatScalar(value)}`];
}

function splitKeyValue(line: string): KeyValue | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === "\"" || char === "'") && line[i - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === ":" && quote === null) {
      return {
        key: unquote(line.slice(0, i).trim()),
        value: line.slice(i + 1).trim()
      };
    }
  }
  return null;
}

function parseScalar(value: string): unknown {
  if (value === "null" || value === "~") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquote(value);
  }
  if (value === "[]") {
    return [];
  }
  if (value === "{}") {
    return {};
  }
  return value;
}

function formatScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value !== "string") {
    return String(value);
  }
  if (value === "") {
    return "\"\"";
  }
  if (/[:#\[\]\{\},&\*!\|>'"%@`]/.test(value) || value.trim() !== value || value === "true" || value === "false" || value === "null") {
    return JSON.stringify(value);
  }
  return value;
}

function unquote(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).split("''").join("'");
  }
  return value;
}

function indentOf(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

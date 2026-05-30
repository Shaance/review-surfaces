import * as YAML from "yaml";

/**
 * Thin wrapper around the `yaml` library that preserves the historical
 * parseYaml / stringifyYaml signatures used across the codebase while keeping
 * artifact output deterministic and human/test friendly.
 */

export function parseYaml(text: string): unknown {
  // The `yaml` library parses empty, whitespace-only, or comment-only input to
  // `null`. The historical hand-rolled parser returned `{}` for those inputs,
  // and at least one caller (config.ts) relies on an empty-but-present file
  // behaving like an empty object (falling through to defaults) rather than an
  // error. Preserve that contract here so every caller sees the prior shape.
  const parsed = YAML.parse(text);
  return parsed === null ? {} : parsed;
}

export function stringifyYaml(value: unknown, indent = 0): string {
  const body = YAML.stringify(value, {
    // Stable, human-readable artifacts:
    indent: 2,
    // Never wrap long scalars; humans and tests diff these line-by-line.
    lineWidth: 0,
    // Never emit anchors/aliases for repeated objects.
    aliasDuplicateObjects: false,
    // Preserve insertion order rather than sorting keys.
    sortMapEntries: false,
    // Keep multi-line strings as literal block scalars.
    blockQuote: "literal"
  });

  if (indent > 0) {
    const prefix = " ".repeat(indent);
    return `${body
      .split("\n")
      .map((line) => (line === "" ? line : `${prefix}${line}`))
      .join("\n")}`;
  }

  return body;
}

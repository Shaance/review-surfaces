// Shared anchor-token scanners for the narrative anchored-or-flagged discipline.
// Both the PR narrative (src/llm/pr-narrative.ts, drop-on-fabrication) and the
// human change narrative (src/human/narrative.ts, demote-on-fabrication) scan
// free text for path-like and ACID-like tokens and check them against the
// deterministic allowlists. Keeping the patterns in one place stops the two
// scanners from drifting apart.

// Path token: a slash-bearing token ending in an extension. A leading-dot
// segment (.github/workflows/ci.yml) is captured too — without the leading dot a
// dot-prefixed allowlisted path is extracted WITHOUT its dot, fails the allowlist
// match, and wrongly flags a valid mention.
export const TEXT_PATH_TOKEN = /(?<![\w./-])\.?[\w-]+(?:\/[\w.-]+)+\.[A-Za-z][\w]*/g; // e.g. src/foo/bar.ts, .github/x/ci.yml

// An ACID: review-surfaces.PRIVACY.2 (group + numeric index).
export const TEXT_ACID_TOKEN = /\b[A-Za-z][\w-]*\.[A-Za-z][\w-]*\.\d+\b/g;

// A ROOT-level filename has no slash, so TEXT_PATH_TOKEN misses it. Match a bare
// filename with a known, file-only extension (e.g. package.json, tsconfig.json,
// README.md). .js/.jsx are deliberately excluded: prose like "Node.js"/"Next.js"
// would otherwise be misread as a fabricated path.
export const TEXT_ROOT_FILE_TOKEN = /(?<![\w./-])[\w-]+\.(?:json|jsonc|ya?ml|toml|cfg|lock|sh|md|tsx?)\b/g;

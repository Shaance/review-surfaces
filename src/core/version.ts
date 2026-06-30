// Single source of truth for the tool version. Kept in lockstep with
// package.json "version" by tests/version.test.ts, which fails if they drift.
// A const (rather than a runtime readFileSync of package.json) keeps this import
// side-effect-free and robust across the dist layout (dist/src/core/version.js)
// and the source layout. Consumers: collect.ts (TOOL_VERSION ->
// manifest.tool_version + signature), cli/index.ts help banner, and
// bootstrap/init.ts feature-spec template default version.
export const VERSION = "0.3.1";

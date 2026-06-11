import fs from "node:fs";
import path from "node:path";

// review-surfaces.COLD_START.1: schemas/ ships inside the npm package (it is in
// package.json `files`), so every DEFAULT schema lookup must resolve from the
// package root, never from the user's current working directory — `validate`
// has to work from a stranger's repository that has no schemas/ of its own.
// An explicit --schema flag remains caller-relative; only defaults route here.
//
// Two candidates cover both layouts this module runs from:
//   dist/src/schema/packaged-schemas.js -> ../../../schemas (built package)
//   src/schema/packaged-schemas.ts      -> ../../schemas    (dev/tsx)
export function packagedSchemaPath(name: string): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "schemas", name),
    path.resolve(__dirname, "..", "..", "schemas", name)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

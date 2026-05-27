import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseAcaiSpec } from "../src/acai/acai";

test("parses Acai object and string requirements with generated ACIDs", async () => {
  const cwd = process.cwd();
  const spec = await parseAcaiSpec(cwd, path.join("tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"));

  assert.equal(spec.feature_name, "example");
  assert.equal(spec.requirements.length, 3);
  assert.deepEqual(
    spec.requirements.map((requirement) => requirement.acai_id),
    ["example.INTENT.1", "example.INTENT.2", "example.QUALITY.1"]
  );
  assert.equal(spec.requirements[0].requirement, "The tool must parse object requirements.");
  assert.equal(spec.requirements[0].note, "Preserve notes.");
  assert.equal(spec.requirements[1].requirement, "The tool must parse string requirements.");
});

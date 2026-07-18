#!/usr/bin/env node
"use strict";

// Keep in sync with package.json engines.node and bin/review-surfaces.js.
const REQUIRED_NODE_MAJOR = 22;
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isNaN(nodeMajor) && nodeMajor < REQUIRED_NODE_MAJOR) {
  process.stderr.write(
    "agreement-audit requires Node >= " + REQUIRED_NODE_MAJOR + "; you are running v" + process.versions.node + ". " +
    "(package.json declares this under engines, but npm/npx does not enforce it.)\n"
  );
  process.exitCode = 1;
  return;
}

const path = require("node:path");
const compiled = path.join(__dirname, "..", "dist", "src", "audit", "cli.js");
try {
  require(compiled).runAgreementAuditCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
} catch (error) {
  if (error && error.code === "MODULE_NOT_FOUND") {
    process.stderr.write("agreement-audit is not built. Run pnpm run build:fast first.\n");
    process.exitCode = 1;
  } else {
    throw error;
  }
}

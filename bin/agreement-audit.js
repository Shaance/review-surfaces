#!/usr/bin/env node
"use strict";

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

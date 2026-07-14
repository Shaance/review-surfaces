#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { readOwnedStickyComment } = require(path.join(
  __dirname,
  "..",
  "dist",
  "src",
  "render",
  "post-comment.js"
));

const result = readOwnedStickyComment(process.env.SUBJECT || process.cwd());
const output = result.status === "found"
  ? {
      status: "found",
      id: result.comment.id,
      head_sha: result.fingerprint?.headSha ?? "",
      run_id: result.fingerprint?.runId ?? ""
    }
  : { status: result.status, reason: result.reason };

process.stdout.write(`${JSON.stringify(output)}\n`);

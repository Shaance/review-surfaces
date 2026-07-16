#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { readOwnedStickyComment, removeStickyComment } = require(path.join(
  __dirname,
  "..",
  "dist",
  "src",
  "render",
  "post-comment.js"
));

const subject = process.env.SUBJECT || process.cwd();
const mode = process.argv[2] || "read";
let output;
if (mode === "remove") {
  const headSha = (process.env.HEAD_SHA || "").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(headSha)) {
    output = { status: "error", reason: "HEAD_SHA is required for exact-head sticky removal." };
  } else {
    const result = removeStickyComment(subject, { headSha });
    output = {
      status: result.removed ? "removed" : "not_removed",
      reason: result.reason
    };
  }
} else if (mode === "read") {
  const result = readOwnedStickyComment(subject);
  output = result.status === "found"
    ? {
        status: "found",
        id: result.comment.id,
        head_sha: result.fingerprint?.headSha ?? "",
        run_id: result.fingerprint?.runId ?? ""
      }
    : { status: result.status, reason: result.reason };
} else {
  output = { status: "error", reason: `Unknown sticky client mode: ${mode}` };
  process.exitCode = 2;
}

process.stdout.write(`${JSON.stringify(output)}\n`);

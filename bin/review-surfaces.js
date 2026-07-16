#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve, sep } = require("node:path");
const {
  containsBlockingSecretMaterial,
  redact
} = require("./privacy-runtime.js");
const { BoundedStreamCapture } = require("./bounded-stream-capture.js");

const root = resolve(dirname(__filename), "..");
const compiledEntry = resolve(root, "dist/src/cli/index.js");
const COMMAND_TRANSCRIPT_EXCERPT_LIMIT = 1200;
const COMMAND_TRANSCRIPT_SCHEMA_VERSION = "review-surfaces.command_transcripts.v1";
const DEFAULT_COMMAND_TRANSCRIPT_DIR = ".review-surfaces/commands";

// review-surfaces.DISTRIBUTION.10: npm/npx does not enforce `engines`, and the
// compiled CLI targets modern Node — on an old runtime it parses fine and then
// dies mid-run with a bare TypeError. Guard here, in the shim that old Node CAN
// parse, with one actionable line. Keep in sync with package.json engines.node
// (pinned by a distribution test).
const REQUIRED_NODE_MAJOR = 22;

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isNaN(nodeMajor) && nodeMajor < REQUIRED_NODE_MAJOR) {
    console.error(
      "review-surfaces requires Node >= " + REQUIRED_NODE_MAJOR + "; you are running v" + process.versions.node + ". " +
      "(package.json declares this under engines, but npm/npx does not enforce it.)"
    );
    return 1;
  }

  const cliArgs = process.argv.slice(2);
  if (!existsSync(compiledEntry)) {
    if (cliArgs[0] === "run") {
      return runBootstrapRecordedCommand(cliArgs.slice(1));
    }
    console.error("review-surfaces is not built. Run `pnpm run build` first.");
    return 1;
  }

  const args = [compiledEntry, ...cliArgs];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

async function runBootstrapRecordedCommand(args) {
  const parsed = parseRunArgs(args);
  if (parsed.positionals.length === 0) {
    console.error("Usage: review-surfaces run [--id <id>] [--command-transcripts <dir>] -- <command> [args...]");
    return 2;
  }

  const result = await recordCommandTranscript({
    cwd: process.cwd(),
    args: parsed.positionals,
    id: stringFlag(parsed, "id"),
    transcriptDir: stringFlag(parsed, "command-transcripts") ?? transcriptDirFromOut(parsed)
  });
  console.error(`Recorded command transcript to ${result.transcriptPath}`);
  return result.exitCode;
}

function parseRunArgs(args) {
  if (args[0] === "--") {
    args = args.slice(1);
  }

  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return { flags, positionals };
}

function stringFlag(parsed, key) {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
}

function transcriptDirFromOut(parsed) {
  const outputDir = stringFlag(parsed, "out");
  return outputDir ? toPosixPath(relative(process.cwd(), join(resolve(process.cwd(), outputDir), "commands"))) : undefined;
}

function recordCommandTranscript(options) {
  const started = new Date();
  const stdout = new BoundedStreamCapture(RAW_EXCERPT_CAP);
  const stderr = new BoundedStreamCapture(RAW_EXCERPT_CAP);
  // Match the compiled recorder: snapshot identity before untrusted command
  // code can mutate the checkout whose validation it is recording.
  const headSha = currentGitHeadSha(options.cwd);
  return runChildCommand(options, stdout, stderr).then((childResult) => {
    const completed = new Date();
    const id = options.id ?? defaultTranscriptId(options.args);
    const stdoutSecretBlocked = stdout.finishAndCheckBlockedSecret();
    const stderrSecretBlocked = stderr.finishAndCheckBlockedSecret();
    const secretBlocked = containsBlockingSecretMaterial(shellCommandString(options.args)) ||
      stdoutSecretBlocked || stderrSecretBlocked;
    const transcript = stripUndefined({
      id,
      command: redact(shellCommandString(options.args)),
      status: childResult.exitCode === 0 ? "passed" : "failed",
      exit_code: childResult.exitCode,
      head_sha: headSha,
      duration_ms: Math.max(0, completed.getTime() - started.getTime()),
      started_at: started.toISOString(),
      completed_at: completed.toISOString(),
      stdout_excerpt: stdout.redactedExcerpt(COMMAND_TRANSCRIPT_EXCERPT_LIMIT),
      stderr_excerpt: stderr.redactedExcerpt(COMMAND_TRANSCRIPT_EXCERPT_LIMIT),
      stdout_hash: stdout.hash(),
      stderr_hash: stderr.hash(),
      truncated: stdout.truncated || stderr.truncated,
      secret_blocked: secretBlocked || undefined
    });

    const transcriptPath = writeTranscriptFile(options.cwd, options.transcriptDir, id, transcript);
    return { transcript, transcriptPath, exitCode: childResult.exitCode };
  });
}

function currentGitHeadSha(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/i.test(value) ? value : undefined;
}

function runChildCommand(options, stdoutCapture, stderrCapture) {
  return new Promise((resolveResult) => {
    const child = spawn(options.args[0], options.args.slice(1), {
      cwd: options.cwd,
      env: process.env,
      shell: false
    });
    let settled = false;

    child.stdout?.on("data", (chunk) => teeChunk(chunk, stdoutCapture, process.stdout, child.stdout));
    child.stderr?.on("data", (chunk) => teeChunk(chunk, stderrCapture, process.stderr, child.stderr));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const message = Buffer.from(`${error.message}\n`);
      stderrCapture.write(message);
      process.stderr.write(message);
      resolveResult({ exitCode: error.code === "ENOENT" ? 127 : 1 });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        stderrCapture.write(Buffer.from(`Command terminated by signal ${signal}\n`));
      }
      resolveResult({ exitCode: typeof code === "number" ? code : 1 });
    });
  });
}

function writeTranscriptFile(cwd, transcriptDir, id, transcript) {
  const dir = resolve(cwd, transcriptDir ?? DEFAULT_COMMAND_TRANSCRIPT_DIR);
  mkdirSync(dir, { recursive: true });
  const absolutePath = join(dir, `${safeFilename(id)}.json`);
  writeFileSync(absolutePath, `${JSON.stringify({
    schema_version: COMMAND_TRANSCRIPT_SCHEMA_VERSION,
    commands: [transcript]
  }, null, 2)}\n`);
  return toPosixPath(relative(cwd, absolutePath));
}

// Raw capture cap mirrors src/commands/runner.ts: bound memory while giving the
// redact-before-truncate step enough context to catch a secret straddling the
// final excerpt limit. The sha256 digest still hashes the FULL raw stream.
const RAW_EXCERPT_CAP = COMMAND_TRANSCRIPT_EXCERPT_LIMIT * 4;

function defaultTranscriptId(args) {
  const hash = crypto.createHash("sha1").update(args.join("\0")).digest("hex").slice(0, 12).toUpperCase();
  return `CMD-${hash}`;
}

function shellCommandString(args) {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function safeFilename(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "command";
}

function teeChunk(chunk, capture, destination, source) {
  capture.write(chunk);
  const canContinue = destination.write(chunk);
  if (canContinue === false && source?.pause && destination.once && source.resume) {
    source.pause();
    destination.once("drain", () => {
      source.resume?.();
    });
  }
}

function stripUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}

function toPosixPath(value) {
  return value.split(sep).join("/");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

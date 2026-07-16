#!/usr/bin/env node
// Regenerate the README screenshots (docs/images/*.png) from a real local run.
//
//   pnpm run local-review            # produce .review-surfaces artifacts first
//   node scripts/readme-screenshots.mjs
//
// For committed README images, prefer a clean checkout or an explicit committed
// range:
//   RS_ARTIFACTS=/tmp/clean-repo/.review-surfaces node scripts/readme-screenshots.mjs
//
// Uses headless Chrome (macOS path by default; override with CHROME_BIN).
// Screenshots are committed so README readers never need this script; it exists
// so the images stay reproducible from real artifacts instead of mockups.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifacts = process.env.RS_ARTIFACTS ? path.resolve(process.env.RS_ARTIFACTS) : path.join(root, ".review-surfaces");
const outDir = path.join(root, "docs", "images");
fs.mkdirSync(outDir, { recursive: true });
const readmePath = path.join(root, "README.md");
const readmeImageBases = ["cockpit", "sticky-comment"];
const readmeImageBaseUrl = "https://raw.githubusercontent.com/Shaance/review-surfaces/main/docs/images";

const humanModelPath = path.join(artifacts, "human_review.json");
const humanModel = JSON.parse(fs.readFileSync(humanModelPath, "utf8"));
const uncommittedFiles = Number(humanModel?.generated_from?.uncommitted_files ?? 0);
if (uncommittedFiles > 0 && process.env.RS_ALLOW_UNCOMMITTED_SCREENSHOTS !== "1") {
  throw new Error(
    `Refusing to generate README screenshots from ${artifacts}: ` +
    `human_review.json includes ${uncommittedFiles} uncommitted file(s). ` +
    "Regenerate from a clean checkout/committed range, or set RS_ALLOW_UNCOMMITTED_SCREENSHOTS=1 for a local-only preview."
  );
}

function shoot(htmlPath, outName, width, height) {
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--screenshot=${path.join(outDir, outName)}`,
    `--window-size=${width},${height}`,
    `file://${htmlPath}`
  ], { stdio: "ignore" });
  console.log(`wrote docs/images/${outName}`);
}

function syncReadmeImageReferences() {
  const replacements = new Map();
  for (const base of readmeImageBases) {
    const sourcePath = path.join(outDir, `${base}.png`);
    const hash = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex").slice(0, 8);
    const hashedName = `${base}-${hash}.png`;
    fs.copyFileSync(sourcePath, path.join(outDir, hashedName));
    replacements.set(base, hashedName);

    const stalePattern = new RegExp(`^${escapeRegExp(base)}-[0-9a-f]{8}\\.png$`);
    for (const fileName of fs.readdirSync(outDir)) {
      if (stalePattern.test(fileName) && fileName !== hashedName) {
        fs.rmSync(path.join(outDir, fileName), { force: true });
      }
    }
  }

  let readme = fs.readFileSync(readmePath, "utf8");
  for (const [base, hashedName] of [...replacements.entries()].sort((a, b) => b[0].length - a[0].length)) {
    const imagePathPattern = new RegExp(
      `(?:https://raw\\.githubusercontent\\.com/Shaance/review-surfaces/main/)?docs/images/${escapeRegExp(base)}(?:-[0-9a-f]{8})?\\.png`,
      "g"
    );
    readme = readme.replace(imagePathPattern, `${readmeImageBaseUrl}/${hashedName}`);
  }
  fs.writeFileSync(readmePath, readme);
  console.log("updated README screenshot references");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 1. The HTML cockpit, top of page: verdict, header strip, review queue.
shoot(path.join(artifacts, "human_review.html"), "cockpit.png", 1280, 900);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-shot-"));

// 2. The sticky PR comment preview: comment.md rendered through a deliberately
// small markdown-to-HTML pass (headings, bold, inline code, lists, fences,
// details) styled like a PR comment. Not a full renderer — just enough for an
// honest picture of the real file.
const md = fs.readFileSync(path.join(artifacts, "comment.md"), "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
const lines = md.split("\n");
let html = "";
let inFence = false;
for (const line of lines) {
  if (line.trim().startsWith("```")) {
    html += inFence ? "</pre>" : '<pre style="background:rgba(38,37,30,.045);border:1px solid #d9d5cf;border-radius:4px;padding:8px 12px;font-size:12px;overflow:hidden">';
    inFence = !inFence;
    continue;
  }
  if (inFence) { html += `${esc(line)}\n`; continue; }
  if (line.startsWith("<!--")) continue;
  if (line.startsWith("<details>")) { html += "<details open>"; continue; }
  if (line.startsWith("<summary>")) { html += `${line}`; continue; }
  if (line.startsWith("</details>")) { html += "</details>"; continue; }
  if (line.startsWith("### ")) { html += `<h3>${inline(line.slice(4))}</h3>`; continue; }
  if (line.startsWith("## ")) { html += `<h2>${inline(line.slice(3))}</h2>`; continue; }
  if (/^\d+\. /.test(line)) { html += `<div style="margin:4px 0">${inline(line)}</div>`; continue; }
  if (line.startsWith("- ") || line.startsWith("   - ")) { html += `<div style="margin:2px 0 2px ${line.startsWith("   ") ? 28 : 12}px">• ${inline(line.replace(/^\s*- /, ""))}</div>`; continue; }
  if (line.trim() === "") { html += "<div style='height:6px'></div>"; continue; }
  html += `<p style="margin:4px 0">${inline(line)}</p>`;
}
const stickyHtml = path.join(tmp, "sticky.html");
fs.writeFileSync(
  stickyHtml,
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f7f7f4;display:flex;justify-content:center">
  <div style="margin:16px;max-width:760px;border:1px solid #d9d5cf;border-radius:4px;padding:8px 16px;font-family:CursorGothic,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.45;color:#26251e;background:#f2f1ed">
  <div style="color:#6f6a60;font-size:12px;padding:4px 0;border-bottom:1px solid #d9d5cf;margin-bottom:6px"><strong style="color:#050503">github-actions</strong> (review-surfaces) commented</div>
  ${html}</div></body>`
);
shoot(stickyHtml, "sticky-comment.png", 820, 980);

syncReadmeImageReferences();
fs.rmSync(tmp, { recursive: true, force: true });

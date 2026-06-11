#!/usr/bin/env node
// Regenerate the README screenshots (docs/images/*.png) from a real local run.
//
//   pnpm run local-review            # produce .review-surfaces artifacts first
//   node scripts/readme-screenshots.mjs
//
// Uses headless Chrome (macOS path by default; override with CHROME_BIN).
// Screenshots are committed so README readers never need this script; it exists
// so the images stay reproducible from real artifacts instead of mockups.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifacts = process.env.RS_ARTIFACTS ? path.resolve(process.env.RS_ARTIFACTS) : path.join(root, ".review-surfaces");
const outDir = path.join(root, "docs", "images");
fs.mkdirSync(outDir, { recursive: true });

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

// 1. The HTML cockpit, top of page: verdict, header strip, review queue.
shoot(path.join(artifacts, "human_review.html"), "cockpit.png", 1280, 900);

// 2. The change map: the cockpit's inline SVG, extracted into a standalone page.
const cockpit = fs.readFileSync(path.join(artifacts, "human_review.html"), "utf8");
const svgMatch = cockpit.match(/<svg[\s\S]*?<\/svg>/);
if (!svgMatch) {
  throw new Error("no inline SVG change map found in human_review.html");
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-shot-"));
const mapHtml = path.join(tmp, "map.html");
// Crop the (deliberately honest, often very wide) map to its dense left region
// for the README teaser: clamp the viewBox width, keep natural scale.
const CROP_WIDTH = 2300;
const viewBox = svgMatch[0].match(/viewBox="0 0 (\d+) (\d+)"/);
const mapWidth = viewBox ? Math.min(Number(viewBox[1]), CROP_WIDTH) : CROP_WIDTH;
const mapHeight = viewBox ? Number(viewBox[2]) : 324;
const croppedSvg = svgMatch[0]
  .replace(/viewBox="0 0 \d+ (\d+)"/, `viewBox="0 0 ${mapWidth} $1"`)
  .replace(/max-width:\d+px/, `max-width:${mapWidth}px`);
fs.writeFileSync(
  mapHtml,
  `<!doctype html><meta charset="utf-8"><body style="margin:16px;background:#ffffff;font-family:-apple-system,system-ui,sans-serif">${croppedSvg}</body>`
);
shoot(mapHtml, "change-map.png", Math.min(mapWidth + 40, 2340), Math.max(mapHeight + 60, 320));

// 3. The sticky PR comment preview: comment.md rendered through a deliberately
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
    html += inFence ? "</pre>" : '<pre style="background:#f6f8fa;border-radius:6px;padding:8px 12px;font-size:12px;overflow:hidden">';
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
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#ffffff;display:flex;justify-content:center">
  <div style="margin:16px;max-width:760px;border:1px solid #d1d9e0;border-radius:8px;padding:8px 16px;font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.45;color:#1f2328">
  <div style="color:#59636e;font-size:12px;padding:4px 0;border-bottom:1px solid #d1d9e0;margin-bottom:6px"><strong>github-actions</strong> (review-surfaces) commented</div>
  ${html}</div></body>`
);
shoot(stickyHtml, "sticky-comment.png", 820, 980);

fs.rmSync(tmp, { recursive: true, force: true });

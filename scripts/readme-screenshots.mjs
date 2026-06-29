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
const readmeImageBases = ["cockpit", "change-map", "change-map-detail", "sticky-comment"];

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
    const imagePathPattern = new RegExp(`docs/images/${escapeRegExp(base)}(?:-[0-9a-f]{8})?\\.png`, "g");
    readme = readme.replace(imagePathPattern, `docs/images/${hashedName}`);
  }
  fs.writeFileSync(readmePath, readme);
  console.log("updated README screenshot references");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
const isOverviewMap = /aria-label="Change map overview"/.test(croppedSvg);
const mapTitle = isOverviewMap ? "Change map overview" : "Change map";
const mapCopy = isOverviewMap
  ? "Cards summarize what changed in each area. In the cockpit, click a card to zoom into topic groups and files."
  : "Changed files are grouped by review topic, with useful file-to-file relationships and review-lens tags when available. In the cockpit, click a file to filter the review queue.";
fs.writeFileSync(
  mapHtml,
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f7f7f4;font-family:CursorGothic,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#26251e">
  <main style="padding:24px 32px 28px">
    <h1 style="font-size:26px;font-weight:400;line-height:32.5px;margin:0 0 8px;color:#050503">${mapTitle}</h1>
    <p style="font-size:14px;line-height:1.45;margin:0 0 18px;color:#6f6a60;max-width:760px">${mapCopy}</p>
    ${croppedSvg}
  </main>
  </body>`
);
shoot(mapHtml, "change-map.png", Math.max(860, Math.min(mapWidth + 80, 2340)), Math.max(mapHeight + 150, 420));

// 3. The map detail view: the same pre-rendered panel the cockpit reveals after
// clicking an overview group.
let firstDetailMatch;
let srcDetailMatch;
let srcRelationshipDetailMatch;
let compactRelationshipDetailMatch;
const detailPattern = /<div class="map-detail" data-map-detail="([^"]+)" hidden><p class="muted">([\s\S]*?)<\/p>(<svg[\s\S]*?<\/svg>)<\/div>/g;
for (const match of cockpit.matchAll(detailPattern)) {
  firstDetailMatch ??= match;
  if (match[1] === "src") {
    srcDetailMatch = match;
  }
  if (!/<polyline\b/.test(match[3])) {
    continue;
  }
  if (match[1] === "src") {
    srcRelationshipDetailMatch = match;
    break;
  }
  if (!compactRelationshipDetailMatch || detailSvgHeight(match[3]) < detailSvgHeight(compactRelationshipDetailMatch[3])) {
    compactRelationshipDetailMatch = match;
  }
}
const detailMatch = srcRelationshipDetailMatch ?? compactRelationshipDetailMatch ?? srcDetailMatch ?? firstDetailMatch;
if (!detailMatch) {
  throw new Error("no hidden change-map detail panel found in human_review.html");
}
const detailGroup = detailMatch[1];
const detailSvg = detailMatch[3];
const detailViewBox = detailSvg.match(/viewBox="0 0 (\d+) (\d+)"/);
const detailWidth = detailViewBox ? Number(detailViewBox[1]) : 860;
const detailHeight = detailViewBox ? Number(detailViewBox[2]) : 360;
const detailHtml = path.join(tmp, "map-detail.html");
fs.writeFileSync(
  detailHtml,
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f7f7f4;font-family:CursorGothic,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#26251e">
  <main style="padding:24px 32px 28px">
    <h1 style="font-size:26px;font-weight:400;line-height:32.5px;margin:0 0 8px;color:#050503">Change map detail: ${detailGroup}</h1>
    <p style="font-size:14px;line-height:1.45;margin:0 0 18px;color:#6f6a60;max-width:760px">This is the view revealed after clicking the <code style="background:rgba(38,37,30,.045);border:1px solid rgba(38,37,30,.08);border-radius:4px;padding:1px 5px">${detailGroup}</code> overview card: topic groups, files, and useful file-to-file relationships when available.</p>
    ${detailSvg}
  </main>
  </body>`
);
shoot(detailHtml, "change-map-detail.png", Math.max(860, Math.min(detailWidth + 80, 2340)), Math.max(detailHeight + 150, 420));

// 4. The sticky PR comment preview: comment.md rendered through a deliberately
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

function detailSvgHeight(svg) {
  const box = svg.match(/viewBox="0 0 \d+ (\d+)"/);
  return Number(box?.[1] ?? Number.MAX_SAFE_INTEGER);
}

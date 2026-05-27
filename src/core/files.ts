import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function readText(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, "utf8");
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, content, "utf8");
}

export async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readText(filePath));
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export async function hashFile(filePath: string): Promise<string> {
  const data = await fs.promises.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function relativePath(cwd: string, filePath: string): string {
  return toPosixPath(path.relative(cwd, filePath));
}

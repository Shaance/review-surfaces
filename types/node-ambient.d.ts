declare const process: any;
declare const console: any;
declare const Buffer: any;

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}

declare module "node:child_process" {
  export const execFileSync: any;
  export const spawnSync: any;
}

declare module "node:crypto" {
  const crypto: any;
  export default crypto;
}

declare module "node:fs" {
  const fs: any;
  export default fs;
  export const existsSync: any;
}

declare module "node:os" {
  const os: any;
  export default os;
}

declare module "node:path" {
  const path: any;
  export default path;
  export const dirname: any;
  export const resolve: any;
}

declare module "node:test" {
  const test: any;
  export default test;
}

declare module "node:url" {
  export const fileURLToPath: any;
}

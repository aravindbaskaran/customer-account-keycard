import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cache = mkdtempSync(join(tmpdir(), "keycard-npm-cache-"));
let packed;
try {
  packed = spawnSync(npm, ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
  });
} finally {
  rmSync(cache, { recursive: true, force: true });
}
if (packed.status !== 0) {
  process.stderr.write(packed.stderr || packed.stdout);
  process.exit(packed.status ?? 1);
}

let artifact;
try {
  const json = packed.stdout.match(/(\[\s*\{[\s\S]*\])\s*$/)?.[1];
  artifact = JSON.parse(json)[0];
} catch {
  throw new Error(`npm pack did not return JSON: ${packed.stdout}`);
}

const paths = artifact.files.map(({ path }) => path);
const required = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.cjs"];
const missing = required.filter((path) => !paths.includes(path));
const unsafe = paths.filter((path) => /(^|\/)(?:\.env(?:\.|$)|\.auth|artifacts|sessions|src|test|docs)(?:\/|$)|\.json\.enc$/i.test(path));
if (missing.length) throw new Error(`tarball is missing required files: ${missing.join(", ")}`);
if (unsafe.length) throw new Error(`tarball contains non-public or sensitive paths: ${unsafe.join(", ")}`);
if (artifact.size > 100 * 1024) throw new Error(`tarball is ${artifact.size} bytes; limit is 102400 bytes`);
if (artifact.unpackedSize > 288 * 1024) throw new Error(`unpacked tarball is ${artifact.unpackedSize} bytes; limit is 294912 bytes`);

console.log(JSON.stringify({ name: artifact.name, version: artifact.version, files: paths.length, compressedBytes: artifact.size, unpackedBytes: artifact.unpackedSize }, null, 2));

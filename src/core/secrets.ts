import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SecretRef } from "./types.js";
import { log } from "./logger.js";

const exec = promisify(execFile);
const cache = new Map<string, string>();

export function isSecretRef(v: string): boolean {
  return /^(env:|op:\/\/|file:)/.test(v);
}

export async function resolveSecret(ref: SecretRef, opts: { redact?: boolean } = {}): Promise<string> {
  if (cache.has(ref)) return cache.get(ref)!;
  let value: string;
  if (ref.startsWith("env:")) {
    const name = ref.slice(4);
    value = process.env[name] ?? "";
    if (!value) throw new Error(`secret ${ref}: environment variable ${name} is not set`);
  } else if (ref.startsWith("op://")) {
    const { stdout } = await exec("op", ["read", ref]);
    value = stdout.trim();
  } else if (ref.startsWith("file:")) {
    const p = ref.slice(5).replace(/^~/, homedir());
    value = (await readFile(resolve(p), "utf8")).trim();
  } else {
    value = ref;
  }
  if (opts.redact !== false) log.redact(value);
  cache.set(ref, value);
  return value;
}

export async function resolveMaybeSecret(v: string | undefined, opts: { redact?: boolean } = {}): Promise<string | undefined> {
  if (v === undefined) return undefined;
  return isSecretRef(v) ? resolveSecret(v, opts) : v;
}

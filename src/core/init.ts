import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function hasKey(text: string): boolean {
  return /^\s*(?:export\s+)?KEYCARD_KEY\s*=/m.test(text);
}

/** Create a project-local session-encryption key without exposing it in output. */
export async function initializeEnvKey(path = ".env"): Promise<{ envFile: string; gitignoreUpdated: boolean }> {
  if (process.env.KEYCARD_KEY) throw new Error("KEYCARD_KEY is already set in the environment; refusing to create another key");
  const target = resolve(path);
  const exists = existsSync(target);
  const existing = exists ? await readFile(target, "utf8") : "";
  if (hasKey(existing)) throw new Error(`${target} already defines KEYCARD_KEY; refusing to replace it`);

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  const key = randomBytes(32).toString("base64");
  const starterFields = exists
    ? ""
    : "\n# Required for the built-in Testmail provider:\nTESTMAIL_API_KEY=\nTESTMAIL_NAMESPACE=\n";
  await writeFile(target, `${existing}${separator}KEYCARD_KEY=${key}\n${starterFields}`, { mode: 0o600 });
  await chmod(target, 0o600).catch(() => {});
  const gitignore = join(dirname(target), ".gitignore");
  const ignored = existsSync(gitignore) && (await readFile(gitignore, "utf8"))
    .split(/\r?\n/)
    .some((line) => [".env", "*.env", "**/.env"].includes(line.trim()));
  if (!ignored) {
    const rules = existsSync(gitignore) ? await readFile(gitignore, "utf8") : "";
    await writeFile(gitignore, `${rules}${rules && !rules.endsWith("\n") ? "\n" : ""}.env\n`);
  }
  return { envFile: target, gitignoreUpdated: !ignored };
}

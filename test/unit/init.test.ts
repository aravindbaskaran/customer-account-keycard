import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEnvKey } from "../../src/core/init.js";

let dir: string;
const savedKey = process.env.KEYCARD_KEY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keycard-init-"));
  delete process.env.KEYCARD_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.KEYCARD_KEY;
  else process.env.KEYCARD_KEY = savedKey;
});

describe("initializeEnvKey", () => {
  it("creates a private .env with a valid session key and Testmail starter fields", async () => {
    const path = join(dir, ".env");
    await expect(initializeEnvKey(path)).resolves.toEqual({ envFile: path, gitignoreUpdated: true });
    const key = readFileSync(path, "utf8").match(/^KEYCARD_KEY=(.+)$/m)?.[1] ?? "";
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("# Required for the built-in Testmail provider:\nTESTMAIL_API_KEY=\nTESTMAIL_NAMESPACE=\n");
  });

  it("appends without replacing other environment settings", async () => {
    const path = join(dir, ".env");
    writeFileSync(path, "TESTMAIL_NAMESPACE=demo");
    await initializeEnvKey(path);
    expect(readFileSync(path, "utf8")).toMatch(/^TESTMAIL_NAMESPACE=demo\nKEYCARD_KEY=/);
    expect(readFileSync(path, "utf8")).not.toContain("TESTMAIL_API_KEY=");
  });

  it("does not duplicate an existing environment ignore rule", async () => {
    const path = join(dir, ".env");
    writeFileSync(join(dir, ".gitignore"), "*.env\n");
    await expect(initializeEnvKey(path)).resolves.toMatchObject({ gitignoreUpdated: false });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*.env\n");
  });

  it("refuses to replace an existing key", async () => {
    const path = join(dir, ".env");
    writeFileSync(path, "KEYCARD_KEY=existing");
    await expect(initializeEnvKey(path)).rejects.toThrow(/refusing to replace/);
  });

  it("refuses when a key is already supplied by the environment", async () => {
    process.env.KEYCARD_KEY = "already-set";
    await expect(initializeEnvKey(join(dir, ".env"))).rejects.toThrow(/already set/);
  });
});

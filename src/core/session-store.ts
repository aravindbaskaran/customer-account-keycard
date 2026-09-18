import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir, stat, chmod, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SavedSession, Shopper, StoreConfig } from "./types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function sessionDir(): string {
  return resolve(process.env.KEYCARD_SESSION_DIR ?? join(homedir(), ".keycard", "sessions"));
}

export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

export function sessionKey(shopper: Pick<Shopper, "id" | "email" | "store">, store?: Pick<StoreConfig, "storeUrl">): string {
  const scope = createHash("sha256").update(JSON.stringify([shopper.id, shopper.store, store?.storeUrl ?? "", shopper.email])).digest("hex").slice(0, 12);
  return `${safeId(shopper.id)}-${scope}`;
}

function loadKey(): Buffer {
  const raw = process.env.KEYCARD_KEY;
  if (!raw) throw new Error("KEYCARD_KEY is not set; refusing to write or read sessions. Generate one with: openssl rand -base64 32");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("KEYCARD_KEY must decode to exactly 32 bytes (base64)");
  return key;
}

export function encrypt(plain: string, key = loadKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decrypt(blob: string, key = loadKey()): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

interface Meta {
  lastChallengeAt: Record<string, number>;
  minted: Record<string, Shopper>;
}

export class SessionStore {
  constructor(readonly dir = sessionDir()) {}

  private sessionPath(key: string) { return join(this.dir, `${key}.json.enc`); }
  private lockPath(key: string) { return join(this.dir, `${key}.lock`); }
  private metaPath() { return join(this.dir, "meta.json"); }

  async ensure() {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    await chmod(this.dir, DIR_MODE).catch(() => {});
  }

  private async writePrivate(path: string, contents: string) {
    await this.ensure();
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, contents, { mode: FILE_MODE });
    await chmod(tmp, FILE_MODE).catch(() => {});
    await rename(tmp, path);
    await chmod(path, FILE_MODE).catch(() => {});
  }

  async load(key: string, expect?: { shopperId: string; email: string; store: string }): Promise<SavedSession | null> {
    const p = this.sessionPath(key);
    if (!existsSync(p)) return null;
    let session: SavedSession;
    try {
      session = JSON.parse(decrypt(await readFile(p, "utf8"))) as SavedSession;
    } catch (err) {
      throw new Error(`cannot read session at ${p}: ${(err as Error).message}`);
    }
    if (expect && (session.shopperId !== expect.shopperId || session.email !== expect.email || session.store !== expect.store)) {
      return null;
    }
    return session;
  }

  async save(key: string, session: SavedSession): Promise<void> {
    await this.writePrivate(this.sessionPath(key), encrypt(JSON.stringify(session)));
  }

  async remove(key: string): Promise<void> {
    await rm(this.sessionPath(key), { force: true });
  }

  async list(): Promise<Array<{ key: string; modifiedAt: Date; session: SavedSession | null }>> {
    if (!existsSync(this.dir)) return [];
    const out: Array<{ key: string; modifiedAt: Date; session: SavedSession | null }> = [];
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith(".json.enc")) continue;
      const key = f.replace(/\.json\.enc$/, "");
      const s = await stat(join(this.dir, f));
      out.push({ key, modifiedAt: s.mtime, session: await this.load(key).catch(() => null) });
    }
    return out;
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.ensure();
    const dir = this.lockPath(key);
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        await mkdir(dir, { mode: DIR_MODE });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const age = Date.now() - (await stat(dir).then((s) => s.mtimeMs).catch(() => Date.now()));
        if (age > 180_000) { await rm(dir, { recursive: true, force: true }); continue; }
        if (Date.now() > deadline) throw new Error(`timed out waiting for lock on ${key}`);
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async readMeta(): Promise<Meta> {
    const p = this.metaPath();
    if (!existsSync(p)) return { lastChallengeAt: {}, minted: {} };
    try {
      const m = JSON.parse(await readFile(p, "utf8"));
      return { lastChallengeAt: m.lastChallengeAt ?? {}, minted: m.minted ?? {} };
    } catch {
      return { lastChallengeAt: {}, minted: {} };
    }
  }

  private async writeMeta(m: Meta): Promise<void> {
    await this.writePrivate(this.metaPath(), JSON.stringify(m, null, 2));
  }

  async lastChallengeAt(email: string): Promise<number> {
    return (await this.readMeta()).lastChallengeAt[email] ?? 0;
  }

  async markChallenge(email: string): Promise<void> {
    const m = await this.readMeta();
    m.lastChallengeAt[email] = Date.now();
    await this.writeMeta(m);
  }

  async rememberMinted(shopper: Shopper): Promise<void> {
    const m = await this.readMeta();
    m.minted[shopper.id] = shopper;
    await this.writeMeta(m);
  }

  async findMinted(id: string): Promise<Shopper | null> {
    return (await this.readMeta()).minted[id] ?? null;
  }

  async listMinted(): Promise<Shopper[]> {
    return Object.values((await this.readMeta()).minted);
  }

  async forgetMinted(id: string): Promise<void> {
    const m = await this.readMeta();
    delete m.minted[id];
    await this.writeMeta(m);
  }
}

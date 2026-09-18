import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionStore, encrypt, decrypt, sessionKey } from "../../src/core/session-store.js";
import type { SavedSession, Shopper } from "../../src/core/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keycard-"));
  process.env.KEYCARD_KEY = randomBytes(32).toString("base64");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const shopper = (over: Partial<Shopper> = {}): Shopper => ({ id: "owner", store: "st", email: "owner@a.test", ephemeral: false, challenges: [], ...over });

const session = (s: Shopper): SavedSession => ({
  shopperId: s.id, store: s.store, email: s.email, ephemeral: s.ephemeral,
  storageState: { cookies: [], origins: [] },
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), lastValidatedAt: new Date().toISOString(),
  browserLevel: "headless", keycardVersion: "0",
});

describe("encryption", () => {
  it("round trips", () => expect(decrypt(encrypt("hello"))).toBe("hello"));
  it("refuses without a key", () => {
    delete process.env.KEYCARD_KEY;
    expect(() => encrypt("x")).toThrow(/KEYCARD_KEY/);
  });
  it("rejects a wrong key", () => {
    const blob = encrypt("x");
    process.env.KEYCARD_KEY = randomBytes(32).toString("base64");
    expect(() => decrypt(blob)).toThrow();
  });
});

describe("sessionKey scoping", () => {
  it("separates the same shopper id across stores, store URLs and emails", () => {
    const a = sessionKey(shopper(), { storeUrl: "https://a.test" });
    const b = sessionKey(shopper({ store: "other" }), { storeUrl: "https://a.test" });
    const c = sessionKey(shopper(), { storeUrl: "https://b.test" });
    const d = sessionKey(shopper({ email: "other@a.test" }), { storeUrl: "https://a.test" });
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).toBe(sessionKey(shopper(), { storeUrl: "https://a.test" }));
    expect(a.startsWith("owner-")).toBe(true);
  });
  it("keeps ids with separators collision free", () => {
    const one = sessionKey(shopper({ id: "st:mint:a-1" }), { storeUrl: "https://a.test" });
    const two = sessionKey(shopper({ id: "st_mint_a-1" }), { storeUrl: "https://a.test" });
    expect(one).not.toBe(two);
  });
});

describe("SessionStore", () => {
  it("saves, loads, lists, removes by key", async () => {
    const s = new SessionStore(dir);
    const who = shopper({ id: "st:mint:b-1", email: "b@a.test", ephemeral: true });
    const key = sessionKey(who, { storeUrl: "https://a.test" });
    await s.save(key, session(who));
    expect((await s.load(key))?.email).toBe("b@a.test");
    const rows = await s.list();
    expect(rows.map((r) => r.key)).toEqual([key]);
    expect(rows[0].session?.shopperId).toBe("st:mint:b-1");
    await s.remove(key);
    expect(await s.load(key)).toBeNull();
  });

  it("refuses a session that does not match the requested shopper", async () => {
    const s = new SessionStore(dir);
    const a = shopper({ id: "owner", email: "a@a.test" });
    const key = sessionKey(a, { storeUrl: "https://a.test" });
    await s.save(key, session(a));
    expect(await s.load(key, { shopperId: "owner", email: "a@a.test", store: "st" })).not.toBeNull();
    expect(await s.load(key, { shopperId: "owner", email: "someone-else@a.test", store: "st" })).toBeNull();
    expect(await s.load(key, { shopperId: "different", email: "a@a.test", store: "st" })).toBeNull();
    expect(await s.load(key, { shopperId: "owner", email: "a@a.test", store: "other-store" })).toBeNull();
  });

  it("writes the directory 0700 and files 0600", async () => {
    const s = new SessionStore(dir);
    const who = shopper();
    const key = sessionKey(who, { storeUrl: "https://a.test" });
    await s.save(key, session(who));
    await s.markChallenge(who.email);
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.dir, `${key}.json.enc`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.dir, "meta.json")).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind after an atomic write", async () => {
    const s = new SessionStore(dir);
    const who = shopper();
    const key = sessionKey(who, { storeUrl: "https://a.test" });
    await s.save(key, session(who));
    await s.save(key, session(who));
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(s.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes work under the same lock", async () => {
    const s = new SessionStore(dir);
    const order: string[] = [];
    await Promise.all([
      s.withLock("x", async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 150)); order.push("a-end"); }),
      s.withLock("x", async () => { order.push("b-start"); order.push("b-end"); }),
    ]);
    expect(["a-start,a-end,b-start,b-end", "b-start,b-end,a-start,a-end"]).toContain(order.join(","));
  });

  it("records challenge times and minted shoppers", async () => {
    const s = new SessionStore(dir);
    expect(await s.lastChallengeAt("e")).toBe(0);
    await s.markChallenge("e");
    expect(Date.now() - (await s.lastChallengeAt("e"))).toBeLessThan(1000);
    await s.rememberMinted(shopper({ id: "m", email: "m@a.test", ephemeral: true }));
    expect((await s.findMinted("m"))?.email).toBe("m@a.test");
    await s.forgetMinted("m");
    expect(await s.findMinted("m")).toBeNull();
  });
});

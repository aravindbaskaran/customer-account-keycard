import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keycard, UnconfirmedSessionError } from "../../src/core/acquire.js";
import { SessionStore, sessionKey } from "../../src/core/session-store.js";
import { registerFlow } from "../../src/flows/index.js";
import type { Flow, KeycardConfig, SavedSession, Shopper, Validity } from "../../src/core/types.js";
import type { Launched } from "../../src/core/ladder.js";

let dir: string;
const env = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keycard-validity-"));
  process.env.KEYCARD_KEY = randomBytes(32).toString("base64");
  process.env.KEYCARD_LOG = "silent";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
});

const shopper: Shopper = { id: "owner", store: "st", email: "owner@a.test", ephemeral: false, challenges: [] };

function fakeLaunch(): (level: "headless" | "headed" | "cdp") => Promise<Launched> {
  return async () => {
    const page = { url: () => "about:blank", route: async () => {}, unroute: async () => {}, close: async () => {}, screenshot: async () => {} };
    const context = {
      newPage: async () => page,
      setDefaultTimeout: () => {},
      storageState: async () => ({ cookies: [], origins: [] }),
    };
    return { browser: { close: async () => {} } as Launched["browser"], context: context as Launched["context"], ownsBrowser: true };
  };
}

function config(): KeycardConfig {
  const store = { id: "st", flow: "shopify-classic-customer" as const, storeUrl: "https://a.test", pool: { provider: "testmail" as const, prefix: "p" }, ttlHours: 24, cooldownSeconds: 0, ladder: ["headless" as const] };
  return { version: 1, defaults: { ttlHours: 24, cooldownSeconds: 0, ladder: ["headless"], challengeTimeoutMs: 100, decisionEngine: "auto" }, providers: {}, stores: { st: { ...store, decisionEngine: "auto" } }, shoppers: { owner: shopper }, configDir: dir };
}

function session(over: Partial<SavedSession> = {}): SavedSession {
  return {
    shopperId: "owner", store: "st", email: "owner@a.test", ephemeral: false,
    storageState: { cookies: [], origins: [] },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), lastValidatedAt: new Date().toISOString(),
    browserLevel: "headless", keycardVersion: "0", ...over,
  };
}

function flowReturning(verdicts: Validity[]): { flow: Flow; calls: () => number } {
  let i = 0;
  const flow: Flow = {
    id: "shopify-classic-customer",
    async login() { throw new Error("should not log in"); },
    async postLogin() {},
    async detectCaptcha() { return false; },
    async validate() { return verdicts[Math.min(i++, verdicts.length - 1)]; },
  };
  return { flow, calls: () => i };
}

describe("validity", () => {
  it("treats a rate-limited or unreachable store as indeterminate and keeps the session", async () => {
    const { flow } = flowReturning(["indeterminate"]);
    registerFlow(flow);
    const kc = new Keycard(config(), new SessionStore(dir));
    const s = session();
    expect(await kc.validity(s)).toBe("indeterminate");
    expect(await kc.validate(s)).toBe(true);
  });

  it("returns a session from cache without logging in when the probe cannot confirm it", async () => {
    const { flow } = flowReturning(["indeterminate"]);
    registerFlow(flow);
    const store = new SessionStore(dir);
    const kc = new Keycard(config(), store, { launchAt: fakeLaunch() });
    await store.save(kc.keyFor(shopper), session());
    const got = await kc.getSession("owner");
    expect(got.shopperId).toBe("owner");
  });

  it("still rejects a definitively dead session", async () => {
    const { flow } = flowReturning(["invalid"]);
    registerFlow(flow);
    expect(await new Keycard(config(), new SessionStore(dir)).validity(session())).toBe("invalid");
    expect(await new Keycard(config(), new SessionStore(dir)).validate(session())).toBe(false);
  });

  it("rejects an expired session without probing at all", async () => {
    const { flow, calls } = flowReturning(["valid"]);
    registerFlow(flow);
    const kc = new Keycard(config(), new SessionStore(dir), { launchAt: fakeLaunch() });
    expect(await kc.validity(session({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).toBe("invalid");
    expect(calls()).toBe(0);
  });

  it("caches a positive verdict instead of probing repeatedly", async () => {
    const { flow, calls } = flowReturning(["valid"]);
    registerFlow(flow);
    const kc = new Keycard(config(), new SessionStore(dir));
    const s = session({ shopperId: "owner" });
    expect(await kc.validity(s)).toBe("valid");
    expect(await kc.validity(s)).toBe("valid");
    expect(calls()).toBe(1);
  });

  it("throttles repeat probes after an inconclusive answer", async () => {
    const { flow, calls } = flowReturning(["indeterminate", "indeterminate"]);
    registerFlow(flow);
    const kc = new Keycard(config(), new SessionStore(dir));
    const s = session({ email: "throttle@a.test", shopperId: "owner" });
    await kc.validity(s);
    await kc.validity(s);
    expect(calls()).toBe(1);
  });
});

describe("strict mode (KEYCARD_REQUIRE_CONFIRMED_SESSION)", () => {
  it("refuses to reuse a session it could not confirm, and logs in instead", async () => {
    let loginCalls = 0;
    const flow: Flow = {
      id: "shopify-classic-customer",
      async login() { loginCalls++; throw new Error("login not wired in this test"); },
      async postLogin() {},
      async detectCaptcha() { return false; },
      async validate() { return "indeterminate"; },
    };
    registerFlow(flow);
    const store = new SessionStore(dir);
    const kc = new Keycard(config(), store, { launchAt: fakeLaunch() });
    await store.save(kc.keyFor(shopper), session());
    await expect(kc.getSession("owner", { requireConfirmed: true })).rejects.toThrow();
    expect(loginCalls).toBeGreaterThan(0);
  });

  it("reuses the same unconfirmed session when strict mode is off", async () => {
    const flow: Flow = {
      id: "shopify-classic-customer",
      async login() { throw new Error("should not log in"); },
      async postLogin() {},
      async detectCaptcha() { return false; },
      async validate() { return "indeterminate"; },
    };
    registerFlow(flow);
    const store = new SessionStore(dir);
    const kc = new Keycard(config(), store);
    await store.save(kc.keyFor(shopper), session());
    expect((await kc.getSession("owner")).shopperId).toBe("owner");
  });

  it("fails with UnconfirmedSessionError when a fresh login cannot be confirmed", async () => {
    const flow: Flow = {
      id: "shopify-classic-customer",
      async login() {},
      async postLogin() {},
      async detectCaptcha() { return false; },
      async validate() { return "indeterminate"; },
    };
    registerFlow(flow);
    const kc = new Keycard(config(), new SessionStore(dir), { launchAt: fakeLaunch() });
    await expect(kc.getSession("owner", { requireConfirmed: true })).rejects.toThrow(UnconfirmedSessionError);
    await expect(kc.getSession("owner", { requireConfirmed: true })).rejects.toThrow(/KEYCARD_REQUIRE_CONFIRMED_SESSION/);
  });

  it("reads the environment variable when no option is passed", async () => {
    const kc = new Keycard(config(), new SessionStore(dir));
    expect(kc.requireConfirmed()).toBe(false);
    process.env.KEYCARD_REQUIRE_CONFIRMED_SESSION = "1";
    expect(kc.requireConfirmed()).toBe(true);
    expect(kc.requireConfirmed({ requireConfirmed: false })).toBe(false);
  });
});

describe("sessionKey", () => {
  it("is stable for the same shopper and store", () => {
    expect(sessionKey(shopper, { storeUrl: "https://a.test" })).toBe(sessionKey(shopper, { storeUrl: "https://a.test" }));
  });
});

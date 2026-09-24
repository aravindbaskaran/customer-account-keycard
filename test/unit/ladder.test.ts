import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keycard } from "../../src/core/acquire.js";
import { SessionStore } from "../../src/core/session-store.js";
import { registerFlow } from "../../src/flows/index.js";
import { humanAllowed } from "../../src/core/ladder.js";
import type { Flow, KeycardConfig } from "../../src/core/types.js";
import type { Launched } from "../../src/core/ladder.js";

let dir: string;
const env = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keycard-ladder-"));
  process.env.KEYCARD_KEY = randomBytes(32).toString("base64");
  process.env.KEYCARD_LOG = "silent";
  process.env.KEYCARD_CDP_URL = "http://127.0.0.1:1";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
});

function config(ladder: KeycardConfig["stores"][string]["ladder"]): KeycardConfig {
  return {
    version: 1,
    defaults: { ttlHours: 1, cooldownSeconds: 0, ladder, challengeTimeoutMs: 1000, decisionEngine: "auto" },
    providers: {},
    stores: { st: { id: "st", flow: "shopify-classic-customer", storeUrl: "https://example.invalid", pool: { provider: "testmail", prefix: "p" }, ttlHours: 1, cooldownSeconds: 0, ladder, decisionEngine: "auto" } },
    shoppers: { s: { id: "s", store: "st", email: "s@x", ephemeral: false, challenges: [{ kind: "human", provider: "human" }] } },
    configDir: dir,
  };
}

const CAPTCHA_PAGE = `data:text/html,<html><body><iframe src="https://newassets.hcaptcha.com/captcha/v1/x" style="width:300px;height:80px"></iframe></body></html>`;

function fakeLaunch(failCdp = false): (level: "headless" | "headed" | "cdp") => Promise<Launched> {
  return async (level) => {
    if (level === "cdp" && failCdp) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    let url = "about:blank";
    const page = {
      evaluate: async <T>(fn: () => T) => fn(),
      goto: async (target: string) => { url = target; },
      url: () => url,
      route: async () => {},
      unroute: async () => {},
      close: async () => {},
      screenshot: async () => {},
    };
    const context = {
      newPage: async () => page,
      setDefaultTimeout: () => {},
      storageState: async () => ({ cookies: [], origins: [] }),
    };
    return { browser: { close: async () => {} } as Launched["browser"], context: context as Launched["context"], ownsBrowser: true };
  };
}

describe("humanAllowed", () => {
  it("is off in CI unless KEYCARD_ALLOW_HUMAN=1", () => {
    process.env.CI = "1";
    delete process.env.KEYCARD_ALLOW_HUMAN;
    expect(humanAllowed()).toBe(false);
    process.env.KEYCARD_ALLOW_HUMAN = "1";
    expect(humanAllowed()).toBe(true);
  });
});

describe("captcha escalation", () => {
  it("detects a captcha iframe and skips the headed level, then refuses cdp in CI", async () => {
    process.env.CI = "1";
    const levels: string[] = [];
    const fake: Flow = {
      id: "shopify-classic-customer",
      async detectCaptcha() { return true; },
      async login(ctx) {
        levels.push(String(await ctx.page.evaluate(() => navigator.userAgent).then(() => "login")));
        await ctx.page.goto(CAPTCHA_PAGE);
        throw new Error("blocked by captcha");
      },
      async postLogin() {},
      async validate() { return true; },
    };
    registerFlow(fake);
    const kc = new Keycard(config(["headless", "headed", "cdp"]), new SessionStore(dir), { launchAt: fakeLaunch() });
    await expect(kc.getSession("s")).rejects.toThrow(/cdp level needs a human/);
    expect(levels.length).toBe(1);
  }, 60_000);

  it("attempts cdp when a human is allowed and reports the connection failure", async () => {
    process.env.KEYCARD_ALLOW_HUMAN = "1";
    const fake: Flow = {
      id: "shopify-classic-customer",
      async detectCaptcha() { return true; },
      async login(ctx) { await ctx.page.goto(CAPTCHA_PAGE); throw new Error("blocked by captcha"); },
      async postLogin() {},
      async validate() { return true; },
    };
    registerFlow(fake);
    const kc = new Keycard(config(["headless", "cdp"]), new SessionStore(dir), { launchAt: fakeLaunch(true) });
    await expect(kc.getSession("s")).rejects.toThrow(/connect|ECONNREFUSED|127\.0\.0\.1:1/);
  }, 60_000);

  it("treats a /challenge URL as captcha", async () => {
    expect(/\/challenge(\?|$)/.test("https://store.myshopify.com/challenge?return=/account")).toBe(true);
  });
});

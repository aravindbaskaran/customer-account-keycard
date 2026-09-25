import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { keycard, getSession, exportSession, getOtp, mint, withShopper, withShoppers, purgeEphemeral, toCookieHeader } from "../../src/index.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = process.env.KEYCARD_LIVE === "1";
const IDENTITY = process.env.KEYCARD_SMOKE_IDENTITY ?? "demo-owner";
const STORE = process.env.KEYCARD_SMOKE_STORE ?? "demo";
const require = createRequire(import.meta.url);
let out: string;

describe.skipIf(!live)("live smoke", () => {
  beforeAll(() => { out = mkdtempSync(join(tmpdir(), "keycard-live-")); });
  afterAll(async () => { rmSync(out, { recursive: true, force: true }); await purgeEphemeral(); });

  it("captures and reuses a named shopper session", async () => {
    const first = await getSession(IDENTITY);
    expect(first.storageState.cookies.length).toBeGreaterThan(0);
    const t0 = Date.now();
    const again = await getSession(IDENTITY);
    expect(again.createdAt).toBe(first.createdAt);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 180_000);

  it("captures a session through the published CommonJS build", async () => {
    const cjs = require("../../dist/index.cjs") as typeof import("../../src/index.js");
    const session = await cjs.getSession(IDENTITY, { force: true });
    expect(session.storageState.cookies.length).toBeGreaterThan(0);
  }, 180_000);

  it("exports a storageState a runner can load", async () => {
    const p = await exportSession(IDENTITY, join(out, "state.json"));
    const state = JSON.parse(readFileSync(p, "utf8"));
    expect(state.cookies.some((c: { name: string }) => c.name === "_shopify_essential")).toBe(true);
    const kc = await keycard();
    const store = kc.config.stores[(await kc.resolveShopper(IDENTITY)).store];
    expect(toCookieHeader(state, `${store.storeUrl}/account`)).toContain("_shopify_essential");
  }, 60_000);

  it("gives a logged-in context via withShopper", async () => {
    await withShopper(IDENTITY, async (context) => {
      const page = await context.newPage();
      const kc = await keycard();
      const storeUrl = kc.config.stores[(await kc.resolveShopper(IDENTITY)).store].storeUrl;
      const res = await page.goto(`${storeUrl}/account`, { waitUntil: "domcontentloaded" });
      expect(res?.ok()).toBe(true);
      expect(page.url()).toMatch(/shopify\.com\/\d+\/account/);
    });
  }, 120_000);

  it("mints a fresh shopper, logs it in, and keeps sessions separate", async () => {
    const gifter = await mint("smoke-gifter", { store: STORE });
    expect(gifter.email).toMatch(/@inbox\.testmail\.app$/);
    const kc = await keycard();
    const storeHost = new URL(kc.config.stores[gifter.store].storeUrl).hostname;
    await withShoppers({ owner: IDENTITY, gifter }, async ({ owner, gifter: g }) => {
      const pick = (cookies: Array<{ name: string; domain: string; value: string }>) =>
        cookies.find((c) => c.name === "_shopify_essential" && c.domain.replace(/^\./, "") === storeHost);
      const oc = pick(await owner.cookies());
      const gc = pick(await g.cookies());
      expect(oc?.value).toBeTruthy();
      expect(gc?.value).toBeTruthy();
      expect(oc!.value).not.toBe(gc!.value);
    });
  }, 300_000);

  it("fetches a code on demand with getOtp", async () => {
    const shopper = await mint("smoke-otp", { store: STORE });
    const kc = await keycard();
    const store = kc.config.stores[shopper.store];
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${store.storeUrl}/password`, { waitUntil: "domcontentloaded" });
      const gate = page.locator('input[name="password"]');
      if (await gate.isVisible({ timeout: 2000 }).catch(() => false)) {
        await gate.fill(store.storefrontPassword!.replace(/^env:/, "") in process.env ? process.env[store.storefrontPassword!.slice(4)]! : store.storefrontPassword!);
        await page.locator('button[type="submit"]').click();
        await page.waitForLoadState("domcontentloaded");
      }
      await page.goto(store.storeUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!customElements.get("shopify-account"), null, { timeout: 15_000 });
      await page.locator('shopify-account button[aria-label="Account"]').first().click();
      const form = page.locator("shopify-login-form form").first();
      await form.locator("#login-form-email").fill(shopper.email);
      const since = Date.now();
      await form.locator('button[type="submit"]').click();
      await page.waitForURL(/\/authentication\/\d+\/code/, { timeout: 45_000 });
      const code = await getOtp(shopper, since);
      expect(code).toMatch(/^\d{6}$/);
    } finally {
      await browser.close();
    }
  }, 180_000);
});

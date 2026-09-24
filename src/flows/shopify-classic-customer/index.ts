import type { Flow } from "../../core/types.js";
import { clearPasswordGate, clickTrustedControl, detectCaptcha, fillTrustedControl, looksLoggedOut, probeAccount } from "../shared.js";
import { sel } from "./selectors.js";

export const shopifyClassicCustomer: Flow = {
  id: "shopify-classic-customer",
  detectCaptcha,

  async login(ctx) {
    const { page, shopper, store } = ctx;
    if (!shopper.password) throw new Error(`shopper ${shopper.id} has no password ref; classic accounts need one`);
    await page.goto(`${store.storeUrl}/password`, { waitUntil: "domcontentloaded" });
    await clearPasswordGate(ctx);
    await page.goto(`${store.storeUrl}/account/login`, { waitUntil: "domcontentloaded" });
    await clearPasswordGate(ctx);
    await fillTrustedControl(ctx, page.locator(sel.email).first(), shopper.email);
    await fillTrustedControl(ctx, page.locator(sel.password).first(), await ctx.secret(shopper.password));
    await clickTrustedControl(ctx, page.locator(sel.submit).first(), "the classic-account sign-in button");
    await page.waitForURL((u) => /\/account(\?|$|\/)/.test(u.pathname) && !looksLoggedOut(u.href), { timeout: 30_000 });
  },

  async postLogin(ctx) {
    await ctx.page.goto(ctx.store.storeUrl, { waitUntil: "domcontentloaded" });
    await ctx.page.waitForTimeout(1000);
  },

  async validate(session, store) {
    return probeAccount(session, store, (finalUrl) => !looksLoggedOut(finalUrl.href));
  },
};

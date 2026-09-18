import type { Page } from "playwright-core";
import type { Flow, FlowContext, StoreConfig } from "../../core/types.js";
import { clearPasswordGate, detectCaptcha, gotoLogin, looksLoggedOut, probeAccount, stubbornClick } from "../shared.js";
import { sel } from "./selectors.js";

function onStore(url: URL, store: StoreConfig): boolean {
  return url.origin === new URL(store.storeUrl).origin;
}

function onAccountPage(url: URL, store: StoreConfig): boolean {
  if (looksLoggedOut(url.href)) return false;
  if (store.shopId && url.href.includes(`shopify.com/${store.shopId}/account`)) return true;
  return sel.accountPage.test(url.href) && (url.hostname === "shopify.com" || onStore(url, store));
}

async function submitEmailViaPopover(ctx: FlowContext): Promise<boolean> {
  const { page, shopper, store, log } = ctx;
  await page.goto(store.storeUrl, { waitUntil: "domcontentloaded" });
  await clearPasswordGate(ctx);
  const button = page.locator(sel.accountButton).first();
  if (!(await button.isVisible({ timeout: 8000 }).catch(() => false))) {
    log.debug("no <shopify-account> popover in the header; falling back to /account/login");
    return false;
  }
  await page.waitForFunction(() => !!customElements.get("shopify-account"), null, { timeout: 15_000 }).catch(() => {});
  const form = page.locator(sel.loginForm).first();
  const email = form.locator(sel.loginEmail).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await stubbornClick(button, "the header account button");
    } catch (err) {
      log.debug((err as Error).message);
      await page.waitForTimeout(1500);
      continue;
    }
    if (await email.isVisible({ timeout: 6000 }).catch(() => false)) break;
    log.debug(`account popover attempt ${attempt + 1}: email form not visible yet`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (!(await email.isVisible().catch(() => false))) {
    log.debug("account popover opened but no email form; falling back to /account/login");
    return false;
  }
  await email.fill(shopper.email);
  await stubbornClick(form.locator(sel.loginSubmit).first(), "the popover sign-in button");
  return true;
}

async function submitEmailViaHostedLogin(ctx: FlowContext): Promise<void> {
  const { page, shopper, store } = ctx;
  const email = page.locator(sel.hostedEmail).first();
  await gotoLogin(ctx, `${store.storeUrl}/account/login`, async () => {
    await clearPasswordGate(ctx);
    await email.waitFor({ state: "visible", timeout: 40_000 });
  });
  await email.fill(shopper.email);
  await page.getByRole("button", { name: sel.hostedContinue }).first().click();
}

async function enterCode(page: Page, code: string): Promise<void> {
  const input = page.locator(sel.codeInput).first();
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(code);
  const submit = page.getByRole("button", { name: sel.codeSubmit }).first();
  if (await submit.isVisible({ timeout: 2000 }).catch(() => false)) await stubbornClick(submit, "the code submit button").catch(() => {});
}

export const shopifyCustomerAccounts: Flow = {
  id: "shopify-customer-accounts",
  detectCaptcha,

  async login(ctx) {
    const { page, store } = ctx;
    await page.goto(`${store.storeUrl}/password`, { waitUntil: "domcontentloaded" });
    await clearPasswordGate(ctx);

    const since = Date.now();
    if (!(await submitEmailViaPopover(ctx))) await submitEmailViaHostedLogin(ctx);

    await Promise.race([
      page.waitForURL((u) => sel.codePage.test(u.href), { timeout: 45_000 }),
      page.locator(sel.codeInput).first().waitFor({ state: "visible", timeout: 45_000 }),
    ]);

    const code = await ctx.challenge("email-code", "Shopify 6-digit login code", since);
    await enterCode(page, code);

    await page.waitForURL((u) => onStore(u, store) || onAccountPage(u, store), { timeout: 45_000 });
  },

  async postLogin(ctx) {
    const { page, store } = ctx;
    if (!onStore(new URL(page.url()), store)) await page.goto(store.storeUrl, { waitUntil: "domcontentloaded" });
    await clearPasswordGate(ctx);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1000);
  },

  async validate(session, store) {
    return probeAccount(session, store, (finalUrl) => onAccountPage(finalUrl, store));
  },
};

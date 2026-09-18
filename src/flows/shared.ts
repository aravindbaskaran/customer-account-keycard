import type { Page } from "playwright-core";
import { FatalLoginError, type FlowContext, type SavedSession, type StoreConfig, type Validity } from "../core/types.js";
import { loadPlaywright } from "../core/pw.js";
import { log } from "../core/logger.js";

export const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en",
};

const INDETERMINATE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function probeAccount(
  session: SavedSession,
  store: StoreConfig,
  isSignedIn: (finalUrl: URL) => boolean,
  attempts = 2,
): Promise<Validity> {
  const { request } = await loadPlaywright();
  let verdict: Validity = "indeterminate";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i));
    const api = await request.newContext({ storageState: session.storageState as never, extraHTTPHeaders: BROWSER_HEADERS });
    try {
      const res = await api.get(`${store.storeUrl}/account`, { maxRedirects: 8, timeout: 15_000 });
      const status = res.status();
      if (INDETERMINATE_STATUS.has(status)) {
        log.debug(`validation probe got ${status} for ${store.id}; treating as indeterminate, not as a dead session`);
        verdict = "indeterminate";
        continue;
      }
      if (!res.ok()) return "invalid";
      return isSignedIn(new URL(res.url())) ? "valid" : "invalid";
    } catch (err) {
      log.debug(`validation probe failed for ${store.id}: ${(err as Error).message.split("\n")[0]}`);
      verdict = "indeterminate";
    } finally {
      await api.dispose();
    }
  }
  return verdict;
}

export const captchaFrameSelector = 'iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="recaptcha"], [data-sitekey], .h-captcha, .cf-turnstile';
export const captchaTextPattern = /confirm you are human|verify you are human|are you a robot/i;

export async function detectCaptcha(page: Page): Promise<boolean> {
  if (/\/challenge(\?|$)/.test(page.url())) return true;
  if (await page.locator(captchaFrameSelector).first().isVisible({ timeout: 500 }).catch(() => false)) return true;
  return page.getByText(captchaTextPattern).first().isVisible({ timeout: 500 }).catch(() => false);
}

export async function stubbornClick(locator: import("playwright-core").Locator, what: string): Promise<void> {
  const attempts: Array<() => Promise<void>> = [
    () => locator.click({ timeout: 8000 }),
    () => locator.click({ timeout: 5000, force: true }),
    () => locator.evaluate((el) => (el as HTMLElement).click()),
  ];
  let lastErr: Error | null = null;
  for (const attempt of attempts) {
    try {
      await attempt();
      return;
    } catch (err) {
      lastErr = err as Error;
      log.debug(`click on ${what} did not take: ${lastErr.message.split("\n")[0]}`);
    }
  }
  throw new Error(`could not click ${what}: ${lastErr?.message.split("\n")[0] ?? "unknown"}`);
}

export async function clearPasswordGate(ctx: FlowContext): Promise<void> {
  if (!ctx.store.storefrontPassword) return;
  const box = ctx.page.locator('form[action*="/password"] input[type="password"], input[name="password"]').first();
  if (!(await box.isVisible({ timeout: 2000 }).catch(() => false))) return;
  await box.fill(await ctx.secret(ctx.store.storefrontPassword));
  await ctx.page.locator('form[action*="/password"] button[type="submit"], button[type="submit"]').first().click();
  await ctx.page.waitForLoadState("domcontentloaded");
}

export function looksLoggedOut(url: string): boolean {
  return /\/login|\/password(\?|$)|accounts\.shopify\.com|\/authentication\//i.test(url);
}

const STALL_HOSTS = ["shop.app"];

export async function gotoLogin(ctx: FlowContext, url: string, ready: () => Promise<void>, timeoutMs = 45_000): Promise<void> {
  const { page } = ctx;
  const pending = new Map<string, number>();
  const onReq = (r: import("playwright-core").Request) => { if (r.isNavigationRequest()) pending.set(r.url(), Date.now()); };
  const onDone = (r: import("playwright-core").Request) => pending.delete(r.url());
  page.on("request", onReq);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  try {
    page.goto(url, { waitUntil: "commit", timeout: timeoutMs }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let readyErr: Error | null = null;
    const readyP = ready().then(() => true, (e) => { readyErr = e; return false; });
    while (Date.now() < deadline) {
      const done = await Promise.race([readyP, new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
      if (done === true) return;
      if (done === false) break;
      for (const [u, started] of pending) {
        const host = new URL(u).hostname;
        if (STALL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) && Date.now() - started > 10_000) {
          throw new FatalLoginError(`login stalled waiting for ${host} (${Math.round((Date.now() - started) / 1000)}s with no response). This store's login routes through "Sign in with Shop"; ${host} must be reachable from this network, or disable Sign in with Shop on the test store (Settings > Customer accounts).`);
        }
      }
    }
    throw readyErr ?? new Error(`login page not ready within ${timeoutMs}ms (at ${page.url()})`);
  } finally {
    page.off("request", onReq);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
}

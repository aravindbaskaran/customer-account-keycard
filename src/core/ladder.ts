import type { Browser, BrowserContext } from "playwright-core";
import { loadPlaywright } from "./pw.js";
import type { BrowserLevel } from "./types.js";

export interface Launched {
  browser: Browser;
  context: BrowserContext;
  ownsBrowser: boolean;
}

export async function launchAt(level: BrowserLevel): Promise<Launched> {
  const { chromium } = await loadPlaywright();
  if (level === "headless") {
    const browser = await chromium.launch({ headless: true });
    return { browser, context: await browser.newContext(), ownsBrowser: true };
  }
  if (level === "headed") {
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: false, channel: "chrome" });
    } catch {
      browser = await chromium.launch({ headless: false });
    }
    return { browser, context: await browser.newContext(), ownsBrowser: true };
  }
  const url = process.env.KEYCARD_CDP_URL ?? "http://127.0.0.1:9222";
  const browser = await chromium.connectOverCDP(url);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { browser, context, ownsBrowser: false };
}

export function humanAllowed(): boolean {
  if (process.env.KEYCARD_ALLOW_HUMAN === "1") return true;
  if (process.env.CI) return false;
  return Boolean(process.stdin.isTTY);
}

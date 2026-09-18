import type { Browser, BrowserContext, BrowserContextOptions } from "playwright-core";
import { loadPlaywright } from "./core/pw.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Keycard, type AcquireOptions } from "./core/acquire.js";
import { loadConfig } from "./core/config.js";
import { SessionStore } from "./core/session-store.js";
import { mintShopper } from "./core/pool.js";
import { resolveMaybeSecret } from "./core/secrets.js";
import { buildProviders } from "./providers/index.js";
import type { KeycardConfig, SavedSession, Shopper, StorageState } from "./core/types.js";

export type { KeycardConfig, SavedSession, Shopper, StorageState, StoreConfig, BrowserLevel } from "./core/types.js";
export { Keycard, UnconfirmedSessionError, type AcquireOptions } from "./core/acquire.js";
export { loadConfig } from "./core/config.js";
export { SessionStore, sessionKey } from "./core/session-store.js";
export { registerFlow } from "./flows/index.js";
export { humanAllowed } from "./core/ladder.js";
export type { Flow, FlowContext } from "./core/types.js";

let shared: Promise<Keycard> | null = null;
const mintedThisProcess = new Set<string>();

export interface KeycardInit {
  config?: string | KeycardConfig;
  sessionStore?: SessionStore;
}

export async function keycard(init: KeycardInit = {}): Promise<Keycard> {
  if (init.config && typeof init.config !== "string") return new Keycard(init.config, init.sessionStore);
  if (init.config || init.sessionStore) return new Keycard(await loadConfig(init.config as string | undefined), init.sessionStore);
  if (!shared) shared = loadConfig().then((c) => new Keycard(c));
  return shared;
}

export async function getSession(who: ShopperRef, opts: AcquireOptions & KeycardInit = {}): Promise<SavedSession> {
  const kc = await keycard(opts);
  return kc.getSession(await who, opts);
}

export async function exportSession(who: ShopperRef, outPath: string, opts: AcquireOptions & KeycardInit = {}): Promise<string> {
  const session = await getSession(who, opts);
  const p = resolve(outPath);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(session.storageState, null, 2), { mode: 0o600 });
  return p;
}

export async function getOtp(who: ShopperRef, since: number, opts: KeycardInit & { timeoutMs?: number } = {}): Promise<string> {
  const kc = await keycard(opts);
  const shopper = await kc.resolveShopper(await who);
  const providers = await buildProviders(kc.config);
  const binding = shopper.challenges.find((b) => b.kind === "email-code" && b.provider !== "human");
  if (!binding) throw new Error(`shopper ${shopper.id} has no email-code binding`);
  const p = providers[binding.provider];
  if (!p) throw new Error(`provider ${binding.provider} is not configured`);
  await kc.store.markChallenge(shopper.email);
  return p.answer({ shopper, since, hint: "login code", timeoutMs: opts.timeoutMs ?? kc.config.defaults.challengeTimeoutMs }, binding);
}

export async function mint(role = "shopper", opts: KeycardInit & { store?: string; meta?: Record<string, string> } = {}): Promise<Shopper> {
  const kc = await keycard(opts);
  const storeIds = Object.keys(kc.config.stores);
  const storeId = opts.store ?? (storeIds.length === 1 ? storeIds[0] : undefined);
  if (!storeId) throw new Error(`mint: pass { store } (known: ${storeIds.join(", ")})`);
  const store = kc.config.stores[storeId];
  if (!store) throw new Error(`mint: unknown store ${storeId}`);
  if (!kc.config.providers.testmail) throw new Error("mint: the testmail provider must be configured");
  const namespace = (await resolveMaybeSecret(kc.config.providers.testmail.namespace, { redact: false }))!;
  const shopper = mintShopper(store, namespace, role, opts.meta);
  await kc.store.rememberMinted(shopper);
  mintedThisProcess.add(shopper.id);
  return shopper;
}

export interface WithShopperOptions extends BrowserContextOptions {
  headless?: boolean;
  browser?: Browser;
  keycard?: KeycardInit;
  acquire?: AcquireOptions;
}

async function openBrowser(opts: WithShopperOptions): Promise<{ browser: Browser; owned: boolean }> {
  if (opts.browser) return { browser: opts.browser, owned: false };
  const { chromium } = await loadPlaywright();
  return { browser: await chromium.launch({ headless: opts.headless ?? true }), owned: true };
}

function contextOptions(opts: WithShopperOptions): BrowserContextOptions {
  const { headless: _h, browser: _b, keycard: _k, acquire: _a, ...rest } = opts;
  return rest;
}

export type ShopperRef = string | Shopper | Promise<string | Shopper>;

export async function withShopper<T>(who: ShopperRef, fn: (context: BrowserContext, shopper: Shopper) => Promise<T>, opts: WithShopperOptions = {}): Promise<T> {
  const kc = await keycard(opts.keycard);
  const shopper = await kc.resolveShopper(await who);
  const session = await kc.getSession(shopper, opts.acquire);
  const { browser, owned } = await openBrowser(opts);
  try {
    const context = await browser.newContext({ ...contextOptions(opts), storageState: session.storageState as never });
    try {
      return await fn(context, shopper);
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    if (owned) await browser.close().catch(() => {});
  }
}

export async function withShoppers<T, K extends string>(
  map: Record<K, ShopperRef>,
  fn: (contexts: Record<K, BrowserContext>, shoppers: Record<K, Shopper>) => Promise<T>,
  opts: WithShopperOptions = {},
): Promise<T> {
  const kc = await keycard(opts.keycard);
  const names = Object.keys(map) as K[];
  const shoppers = {} as Record<K, Shopper>;
  const sessions = {} as Record<K, SavedSession>;
  for (const name of names) {
    shoppers[name] = await kc.resolveShopper(await map[name]);
    sessions[name] = await kc.getSession(shoppers[name], opts.acquire);
  }
  const { browser, owned } = await openBrowser(opts);
  const contexts = {} as Record<K, BrowserContext>;
  try {
    for (const name of names) {
      contexts[name] = await browser.newContext({ ...contextOptions(opts), storageState: sessions[name].storageState as never });
    }
    return await fn(contexts, shoppers);
  } finally {
    for (const name of names) await contexts[name]?.close().catch(() => {});
    if (owned) await browser.close().catch(() => {});
  }
}

export function toCookieHeader(session: SavedSession | StorageState, url: string): string {
  const state = "storageState" in session ? session.storageState : session;
  const u = new URL(url);
  return state.cookies
    .filter((c) => {
      const d = c.domain.replace(/^\./, "");
      const domainOk = u.hostname === d || u.hostname.endsWith(`.${d}`);
      const pathOk = u.pathname.startsWith(c.path || "/");
      const secureOk = !c.secure || u.protocol === "https:";
      return domainOk && pathOk && secureOk && (c.expires === -1 || c.expires * 1000 > Date.now());
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export async function purgeEphemeral(opts: KeycardInit & { all?: boolean } = {}): Promise<string[]> {
  const kc = await keycard(opts);
  const shoppers = opts.all ? await kc.store.listMinted() : (await Promise.all([...mintedThisProcess].map((id) => kc.store.findMinted(id)))).filter((s): s is Shopper => !!s);
  for (const shopper of shoppers) {
    await kc.store.remove(kc.keyFor(shopper));
    await kc.store.forgetMinted(shopper.id);
    mintedThisProcess.delete(shopper.id);
  }
  return shoppers.map((s) => s.id);
}

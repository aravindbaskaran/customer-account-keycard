import type { BrowserLevel, ChallengeKind, ChallengeProvider, FatalLoginError, Flow, FlowContext, KeycardConfig, SavedSession, Shopper, StoreConfig, Validity } from "./types.js";
import { SessionStore, sessionKey } from "./session-store.js";
import { launchAt, humanAllowed, type Launched } from "./ladder.js";
import { resolveSecret } from "./secrets.js";
import { log } from "./logger.js";
import { getFlow } from "../flows/index.js";
import { closeDecisionEngine, warmDecisionEngine } from "../flows/decision.js";
import { installTrustedNavigationGuard } from "../flows/shared.js";
import { buildProviders } from "../providers/index.js";

import { VERSION } from "../version.js";

export class CaptchaError extends Error {}

const VALIDATE_CACHE_MS = 5 * 60_000;
const PROBE_MIN_INTERVAL_MS = 15_000;

export interface AcquireOptions {
  force?: boolean;
  level?: BrowserLevel;
  timeoutMs?: number;
  /** Refuse to return a session that was not positively confirmed in this run. Defaults to KEYCARD_REQUIRE_CONFIRMED_SESSION=1. */
  requireConfirmed?: boolean;
}

export class UnconfirmedSessionError extends Error {}

export interface KeycardDependencies {
  launchAt?: (level: BrowserLevel) => Promise<Launched>;
}

export class Keycard {
  readonly store: SessionStore;
  private providers: Record<string, ChallengeProvider> | null = null;
  private readonly validatedAt = new Map<string, number>();
  private readonly probedAt = new Map<string, number>();

  constructor(readonly config: KeycardConfig, store = new SessionStore(), private readonly dependencies: KeycardDependencies = {}) {
    for (const storeConfig of Object.values(config.stores)) {
      let storeUrl: URL;
      try {
        storeUrl = new URL(storeConfig.storeUrl);
      } catch {
        throw new Error(`store ${storeConfig.id} storeUrl must be an absolute HTTPS URL`);
      }
      if (storeUrl.protocol !== "https:") throw new Error(`store ${storeConfig.id} storeUrl must use HTTPS`);
    }
    config.defaults.decisionEngine ??= "local-ranker";
    for (const storeConfig of Object.values(config.stores)) storeConfig.decisionEngine ??= config.defaults.decisionEngine;
    this.store = store;
  }

  storeOf(shopper: Shopper): StoreConfig {
    const s = this.config.stores[shopper.store];
    if (!s) throw new Error(`shopper ${shopper.id} references unknown store ${shopper.store}`);
    return s;
  }

  async resolveShopper(who: string | Shopper): Promise<Shopper> {
    if (typeof who !== "string") return who;
    const named = this.config.shoppers[who];
    if (named) return named;
    const minted = await this.store.findMinted(who);
    if (minted) return minted;
    throw new Error(`unknown shopper ${who}; known: ${Object.keys(this.config.shoppers).join(", ") || "(none)"}`);
  }

  private async getProviders(): Promise<Record<string, ChallengeProvider>> {
    if (!this.providers) this.providers = await buildProviders(this.config);
    return this.providers;
  }

  async validity(session: SavedSession): Promise<Validity> {
    const store = this.config.stores[session.store];
    if (!store) return "invalid";
    if (new Date(session.expiresAt).getTime() < Date.now()) return "invalid";
    const key = sessionKey({ id: session.shopperId, email: session.email, store: session.store }, store);
    const cached = this.validatedAt.get(key);
    if (cached && Date.now() - cached < VALIDATE_CACHE_MS) return "valid";
    const lastProbe = this.probedAt.get(key);
    if (lastProbe && Date.now() - lastProbe < PROBE_MIN_INTERVAL_MS) return "indeterminate";
    this.probedAt.set(key, Date.now());
    const verdict = await getFlow(store.flow).validate(session, store, resolveSecret);
    if (verdict === "valid") this.validatedAt.set(key, Date.now());
    else this.validatedAt.delete(key);
    if (verdict === "indeterminate") {
      log.warn(`could not confirm the session for ${session.shopperId} (the store or shopify.com did not give a usable answer, often a 429). Keeping it rather than logging in again and burning a login code.`);
    }
    return verdict;
  }

  async validate(session: SavedSession): Promise<boolean> {
    return (await this.validity(session)) !== "invalid";
  }

  keyFor(shopper: Shopper): string {
    return sessionKey(shopper, this.config.stores[shopper.store]);
  }

  private expectation(shopper: Shopper) {
    return { shopperId: shopper.id, email: shopper.email, store: shopper.store };
  }

  private useCache(opts: AcquireOptions): boolean {
    return !opts.force && process.env.KEYCARD_NO_CACHE !== "1";
  }

  requireConfirmed(opts: AcquireOptions = {}): boolean {
    return opts.requireConfirmed ?? process.env.KEYCARD_REQUIRE_CONFIRMED_SESSION === "1";
  }

  async getSession(who: string | Shopper, opts: AcquireOptions = {}): Promise<SavedSession> {
    const shopper = await this.resolveShopper(who);
    log.redact(shopper.email);
    const store = this.storeOf(shopper);
    const key = this.keyFor(shopper);
    const strict = this.requireConfirmed(opts);
    const usable = async (session: SavedSession | null) => {
      if (!session) return false;
      const verdict = await this.validity(session);
      if (verdict === "valid") return true;
      if (verdict === "indeterminate" && !strict) return true;
      if (verdict === "indeterminate") log.info(`strict mode: the saved session for ${shopper.id} could not be confirmed, logging in again`);
      return false;
    };
    if (this.useCache(opts)) {
      const existing = await this.store.load(key, this.expectation(shopper));
      if (await usable(existing)) {
        log.debug(`session for ${shopper.id} valid until ${existing!.expiresAt}`);
        return existing!;
      }
      if (existing) log.info(`session for ${shopper.id} is stale, logging in again`);
    }
    return this.store.withLock(key, async () => {
      if (this.useCache(opts)) {
        const again = await this.store.load(key, this.expectation(shopper));
        if (await usable(again)) return again!;
      }
      return this.login(shopper, store, opts);
    });
  }

  private async waitCooldown(shopper: Shopper, store: StoreConfig, timeoutMs: number) {
    const last = await this.store.lastChallengeAt(shopper.email);
    const wait = last + store.cooldownSeconds * 1000 - Date.now();
    if (wait <= 0) return;
    if (wait > timeoutMs) throw new Error(`cooldown: a login code was sent ${Math.round((Date.now() - last) / 1000)}s ago; wait ${Math.ceil(wait / 1000)}s or mint a fresh shopper`);
    log.info(`cooldown: waiting ${Math.ceil(wait / 1000)}s before requesting another code`);
    await new Promise((r) => setTimeout(r, wait));
  }

  private async login(shopper: Shopper, store: StoreConfig, opts: AcquireOptions): Promise<SavedSession> {
    const flow: Flow = getFlow(store.flow);
    await warmDecisionEngine(store.decisionEngine);
    const providers = await this.getProviders();
    const timeoutMs = opts.timeoutMs ?? this.config.defaults.challengeTimeoutMs;
    const ladder = opts.level ? [opts.level] : store.ladder;
    let lastErr: Error | null = null;

    for (let i = 0; i < ladder.length; i++) {
      const level = ladder[i];
      if (level === "cdp" && !humanAllowed()) {
        lastErr = new Error(`cdp level needs a human and none is allowed here (set KEYCARD_ALLOW_HUMAN=1)${lastErr ? `; previous level failed with: ${lastErr.message}` : ""}`);
        break;
      }
      log.info(`logging in ${shopper.id} on ${store.id} at level ${level}`);
      const launched = await (this.dependencies.launchAt ?? launchAt)(level);
      const { context } = launched;
      const page = await context.newPage();
      context.setDefaultTimeout(30_000);
      let decisionContext: FlowContext | undefined;
      let removeNavigationGuard: (() => Promise<void>) | undefined;
      try {
        const ctx: FlowContext = {
          page,
          context,
          shopper,
          store,
          log,
          secret: resolveSecret,
          challenge: async (kind: ChallengeKind, hint: string, since: number) => {
            if (kind === "email-code") {
              await this.waitCooldown(shopper, store, timeoutMs);
              await this.store.markChallenge(shopper.email);
            }
            return this.answer(shopper, kind, hint, since, timeoutMs, providers, level);
          },
        };
        decisionContext = ctx;
        removeNavigationGuard = await installTrustedNavigationGuard(ctx);
        await flow.login(ctx);
        await flow.postLogin(ctx);
        const state = (await context.storageState()) as SavedSession["storageState"];
        const now = new Date();
        const session: SavedSession = {
          shopperId: shopper.id,
          store: store.id,
          email: shopper.email,
          ephemeral: shopper.ephemeral,
          storageState: state,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + store.ttlHours * 3_600_000).toISOString(),
          lastValidatedAt: now.toISOString(),
          browserLevel: level,
          keycardVersion: VERSION,
        };
        const verdict = await flow.validate(session, store, resolveSecret);
        if (verdict === "invalid") throw new Error("login finished but the session did not validate");
        if (verdict === "indeterminate") {
          if (this.requireConfirmed(opts)) {
            await this.store.save(this.keyFor(shopper), session);
            throw new UnconfirmedSessionError(
              `logged in, but the store would not confirm the session (often a 429 from shopify.com). ` +
                `KEYCARD_REQUIRE_CONFIRMED_SESSION is set, so keycard is failing instead of handing you an unconfirmed session. ` +
                `The session was saved: retry in a minute, or unset the variable to accept it.`,
            );
          }
          log.warn("login finished but the store did not confirm the session (often a 429). Saving it anyway; run `keycard validate` later to confirm.");
        }
        await this.store.save(this.keyFor(shopper), session);
        this.validatedAt.set(this.keyFor(shopper), Date.now());
        log.info(`session saved for ${shopper.id}, expires ${session.expiresAt}`);
        return session;
      } catch (err) {
        lastErr = err as Error;
        const captcha = await flow.detectCaptcha(page).catch(() => false);
        await this.saveArtifacts(page, shopper, level).catch(() => {});
        if (lastErr instanceof UnconfirmedSessionError) break;
        if ((err as FatalLoginError).fatal) {
          log.warn(`level ${level} failed: ${lastErr.message}`);
          break;
        }
        if (captcha) {
          log.warn(`captcha detected at level ${level}; escalating to cdp`);
          const cdpIndex = ladder.indexOf("cdp");
          if (cdpIndex > i) i = cdpIndex - 1;
          else if (cdpIndex === -1) break;
          continue;
        }
        log.warn(`level ${level} failed: ${lastErr.message}`);
      } finally {
        if (removeNavigationGuard) await removeNavigationGuard().catch(() => {});
        if (process.env.KEYCARD_KEEP_BROWSER === "1") {
          log.warn("keeping the browser open for live diagnosis (KEYCARD_KEEP_BROWSER=1)");
          const keepOpenMs = Number(process.env.KEYCARD_KEEP_BROWSER_MS ?? 30_000);
          if (Number.isFinite(keepOpenMs) && keepOpenMs > 0) await new Promise((resolve) => setTimeout(resolve, keepOpenMs));
        } else if (launched.ownsBrowser) await launched.browser.close().catch(() => {});
        else await page.close().catch(() => {});
        if (decisionContext) await closeDecisionEngine(decisionContext).catch(() => {});
      }
    }
    throw lastErr ?? new Error("login failed at every level");
  }

  private async answer(shopper: Shopper, kind: ChallengeKind, hint: string, since: number, timeoutMs: number, providers: Record<string, ChallengeProvider>, level: BrowserLevel): Promise<string> {
    const bindings = shopper.challenges.filter((b) => b.kind === kind || b.kind === "human");
    let lastErr: Error | null = null;
    for (const b of bindings) {
      if (b.provider === "human" && !humanAllowed()) continue;
      if (b.provider === "human" && level === "cdp") continue;
      const p = providers[b.provider];
      if (!p) { lastErr = new Error(`provider ${b.provider} is not configured`); continue; }
      try {
        const code = await p.answer({ shopper, since, hint, timeoutMs }, b);
        log.redact(code);
        log.debug(`${b.provider} answered ${kind} for ${shopper.id}`);
        return code;
      } catch (err) {
        lastErr = err as Error;
        log.warn(`${b.provider}: ${lastErr.message}`);
      }
    }
    throw lastErr ?? new Error(`no provider could answer ${kind} for ${shopper.id}`);
  }

  private async saveArtifacts(page: import("playwright-core").Page, shopper: Shopper, level: BrowserLevel) {
    log.warn("login failed before session capture completed");
    if (process.env.KEYCARD_ARTIFACTS !== "1") {
      log.warn("set KEYCARD_ARTIFACTS=1 to capture a failure screenshot (it can contain the shopper email and, on the code screen, a login code)");
      return;
    }
    const dir = process.env.KEYCARD_ARTIFACT_DIR ?? `${this.store.dir}/../artifacts`;
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${dir}/${shopper.id.replace(/[^A-Za-z0-9._-]+/g, "_")}-${level}-${stamp}`;
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    await chmod(`${base}.png`, 0o600).catch(() => {});
    log.warn(`screenshot saved: ${base}.png . Review it before sharing: it may contain an email address or a login code.`);
  }
}

---
layout: default
title: Design
permalink: /docs/design/
---

# customer-account-keycard: design

Package name: `customer-account-keycard`; CLI: `keycard`.

Scope: **Shopify storefront customer sessions only.** Primary target is new customer accounts (email code login). Classic customer accounts (password) are the second flow. Admin/staff login, other platforms, app portals and SMS factors are out of scope (section 2).

Status (2026-09-18): see the [README](https://github.com/aravindbaskaran/customer-account-keycard/blob/main/README.md) for live-verification results and
[QUALITY.md]({{ '/docs/quality/' | relative_url }}) for the reproducible package baseline.

## 0. In one page

**What it is.** A library that captures, validates, and reuses Shopify customer
sessions for headless tests. It reads emailed login codes from a configured test
inbox and can mint distinct shopper addresses for scenarios that need them.

**Inputs.** Once per store:

| Input | Example | Who provides it |
|---|---|---|
| A store entry in `keycard.json` | store URL, shop id, storefront password *ref*, inbox pool (`testmail` namespace + prefix) | you, once per store |
| Named shoppers in the same file (optional) | `demo-owner` -> `ns.demo-owner@inbox.testmail.app`, role `owner` | you, for demo/recording identities that must stay stable |
| Secrets in `.env` | `TESTMAIL_API_KEY`, `TESTMAIL_NAMESPACE`, `KEYCARD_KEY`, the storefront password | you, once |

Ephemeral shoppers need no named configuration: `mint()` returns a fresh address,
and Shopify creates the customer on first code login.

**Who consumes it.**

| Consumer | How |
|---|---|
| Plain `playwright` scripts | `withShopper("demo-owner", async (context) => {...})`, or load the exported `.auth/x.json` as `storageState` |
| Multi-shopper scenarios (owner vs gifter, A logs out then B, guest then login merge) | `withShoppers({ owner: "demo-owner", gifter: mint("gifter") }, async ({ owner, gifter }) => {...})` |
| `@playwright/test` suites | `setup` project runs `exportSession`; specs use `test.use({ storageState })` |
| Playwright MCP (agent-driven testing) | start with `--storage-state .auth/x.json`, or the agent calls `get_otp` and types the code itself |
| MCP clients | MCP tools `get_session`, `mint_shopper`, `get_otp` |
| curl / API probes | `toCookieHeader(session)` |
| CI | nightly `refresh` keeps named sessions warm; test jobs restore the cache |

**What it does not help with.** Tests whose subject is the login screen itself (they still drive it, but can use `get_otp`), and a captcha on classic login, which needs a human once via the `cdp` level.

## 1. Problem

Shopify new customer accounts replaced passwords with a per-login emailed code. That is good for shoppers and bad for automation:

- A test needs a real inbox to read the code, per shopper, per login.
- Shopify silently rate-limits code sends per address, so "log in at the start of every test" stops working after a few runs.
- The login happens on shopify.com, not the store domain; the store's Liquid `customer` object stays logged out until the session is bridged onto the store domain.
- Multi-shopper scenarios (registry owner and gifter, B2B company admin and location buyer, A then B in the same browser) need many distinct customers, and the naive answer is many inboxes or `abc+xyz1@` variants, neither of which scales across an org. The community thread above asks exactly this and has no answer.

## 2. Non-goals

- No captcha solving, no fingerprint spoofing, no "stealth" plugins. A captcha on classic login escalates to a human.
- No mocked or forged sessions. Every session comes from a real login on a store we own or are authorized to test.
- Not a test runner. It produces sessions and shoppers; Playwright (or anything that loads cookies) consumes them.
- Out of scope, deliberately: Shopify Admin/staff login, POS, Shop Pay SMS codes, BigCommerce or any other platform, the a third-party storefront platform agency portal login, TOTP/SMS providers. The provider and flow interfaces stay open so these could be added, but nothing in the plan builds them.

## 3. Core model

- **Store**: one Shopify store and environment: URL, shop id, storefront password ref, which flow (new or classic accounts), and an inbox pool.
- **Inbox pool**: one testmail namespace (or one IMAP mailbox with plus-addressing) that yields unlimited addresses. `mint(role?)` returns `{ns}.{prefix}-{role}-{shortid}@inbox.testmail.app`. Nothing is created anywhere; Shopify creates the customer on first code login.
- **Shopper (identity)**: a named, stable shopper (`demo-owner`) declared in the file, or an ephemeral one returned by `mint()`. Both carry an email, a role label, a store ref, and optional metadata (company, location for B2B; tags for scenarios).
- **Flow**: driver for one login UI: `shopify-customer-accounts` (code) or `shopify-classic-customer` (password).
- **Challenge provider**: answers the email code: `testmail` (primary), `imap` (fallback), `human` (last resort).
- **Session store**: persisted validated sessions with encryption, TTL, validation probe and a per-shopper lock.
- **Browser ladder**: `headless` -> `headed` -> `cdp` (attach to a real Chrome a human is driving), used only when a level fails or a captcha appears.

### 3.1 Acquire sequence

```
getSession(shopper)
  1. store.load(shopper)             -> hit? run flow.validate(session)
  2. valid?                          -> return it (fast path, no login)
  3. lock(shopper)                   -> one worker logs in per shopper
  4. cooldown check                  -> last code send to this address < N seconds ago? wait, or fail fast
  5. for level in ladder:
       flow.login(page, shopper, provider)     -> requests the code from the provider
       flow.postLogin(page)                    -> visit store root to bridge _shopify_essential
       session = context.storageState()
       flow.validate(session) ok?   -> break
  6. store.save(shopper, session, meta)
  7. unlock, return
```

Ephemeral shoppers skip step 1 on first use (nothing cached) and are cached for the rest of the run so a scenario can reopen the same shopper in a new context without a second code send.

### 3.2 Types

```ts
export interface StoreConfig {
  id: string;                       // "demo"
  flow: "shopify-customer-accounts" | "shopify-classic-customer";
  storeUrl: string;
  shopId?: string;                  // numeric id in shopify.com/{shopId}/account URLs
  storefrontPassword?: SecretRef;
  pool: { provider: "testmail" | "imap"; prefix: string };
  ttlHours?: number;                // default 168
  cooldownSeconds?: number;         // default 120
  ladder?: BrowserLevel[];          // default ["headless", "headed", "cdp"]
}

export interface Shopper {
  id: string;                       // "demo-owner" or "demo:mint:gifter-01j8..."
  store: string;                    // StoreConfig.id
  email: string;
  role?: string;                    // free label: owner, gifter, buyer, company-admin, location-buyer
  password?: SecretRef;             // classic accounts only
  ephemeral: boolean;
  meta?: Record<string, string>;    // company, location, tags; informational, or used by provisioning hooks
  challenges: ChallengeBinding[];   // default from the store pool: [testmail, human]
}

export interface ChallengeBinding {
  kind: "email-code" | "human";
  provider: "testmail" | "imap" | "human";
  options?: { subjectPattern?: string; codePattern?: string; tag?: string; mailbox?: string };
}

export interface ChallengeProvider {
  kinds: ChallengeBinding["kind"][];
  answer(req: { shopper: Shopper; since: number; hint?: string; timeoutMs: number }, binding: ChallengeBinding): Promise<string>;
}

export interface Flow {
  id: StoreConfig["flow"];
  login(ctx: FlowContext): Promise<void>;
  postLogin(ctx: FlowContext): Promise<void>;
  validate(session: SavedSession, store: StoreConfig): Promise<boolean>;
}

export interface FlowContext {
  page: Page;
  context: BrowserContext;
  shopper: Shopper;
  store: StoreConfig;
  challenge(kind: ChallengeBinding["kind"], hint: string, since: number): Promise<string>;
  secret(ref: SecretRef): Promise<string>;
  log: Logger;                      // redacts codes, passwords
}

export type BrowserLevel = "headless" | "headed" | "cdp";

export interface SavedSession {
  shopperId: string;
  store: string;
  storageState: StorageState;       // Playwright shape: cookies + origins
  createdAt: string;
  expiresAt: string;
  lastValidatedAt: string;
  browserLevel: BrowserLevel;
  keycardVersion: string;
}

export type SecretRef = `env:${string}` | `op://${string}` | `file:${string}`;
```

### 3.3 Public API

```ts
getSession(shopperId | Shopper): Promise<SavedSession>
exportSession(shopperId | Shopper, outPath): Promise<string>
withShopper(shopperId | Shopper, fn: (context, shopper) => Promise<T>, contextOptions?): Promise<T>
withShoppers(map: Record<name, shopperId | Shopper>, fn: (contexts: Record<name, BrowserContext>) => Promise<T>, contextOptions?): Promise<T>
mint(role?: string, opts?: { store?: string; meta?: Record<string,string> }): Shopper
getOtp(shopperId | Shopper, since: number): Promise<string>
toCookieHeader(session, url): string
```

`withShoppers` opens one context per shopper in a single browser, so "owner does X, gifter sees Y" runs in one script with no shared cookies.

### 3.4 Provisioning hooks (optional, later)

New customer accounts creates a bare customer on first login. Scenarios that need the customer to already have tags, a company, or a location (B2B roles) can register a `provision(shopper)` hook that runs after the first successful login. The reference implementation would use the Admin GraphQL API with an app access token (`customerUpdate` tags, `companyAssignCustomerAsContact`, `companyLocationAssignRoles`). This is an API call, not an admin UI login, and stays optional: it is only listed so B2B role testing has a home.

## 4. Flows

| Flow | Steps | Challenge | Validate probe | Post-login |
|---|---|---|---|---|
| `shopify-customer-accounts` | store root -> header `<shopify-account>` button -> `<shopify-login-form>` email -> hosted `shopify.com/authentication/{id}/code` page -> `input[autocomplete=one-time-code]` -> back on the store. Fallback for themes without the popover: `/account/login` -> `#customer-authentication-web-email` -> Continue | `email-code`, subject `/is your code/`, `\d{6}` | GET `{storeUrl}/account` with the saved cookies and browser-like `User-Agent`/`Accept` headers (shopify.com answers 406 otherwise); pass on 200 at `shopify.com/{shopId}/account` | land on `{storeUrl}` root once so `_shopify_essential` is set on the store domain; clear the storefront password gate first |
| `shopify-classic-customer` | `/account/login` email + password | none; `human` if hCaptcha appears | GET `/account`, not redirected to `/account/login` | password gate |

Selectors and URL patterns live in a per-flow `selectors.ts` with a `verifiedOn` date. When Shopify changes markup the fix is one file and the drift is visible.

Shopify-specific notes:

- The direct `/account/login` route now goes `shopify.com/{id}/account` -> `authentication/{id}/oauth/authorize` -> `{store}/services/login_with_shop/buyer/start` -> `shop.app/accounts/bounce` before it ever shows an email field. That hop is "Sign in with Shop" checking whether the browser already has a Shop identity. The header popover submits the email first and goes straight to the hosted code page, so it never touches `shop.app`. That is why the popover is the primary path.
- `shop.app` can be unreachable from some networks (during the live run, the ISP resolver returned a Reliance Jio address for `shop.app` instead of Shopify's). keycard watches for a navigation stalled on `shop.app` for more than 10s and fails fast with that reason instead of retrying every ladder level.
- New customer accounts login is hosted on `shopify.com/{shopId}/account` (or `account.{customdomain}`); the storageState captured in one context covers both that origin and the store origin, which is why state is saved from the whole context and never rebuilt cookie by cookie.
- Codes are single use and expire in minutes; the provider filters by `since` (the timestamp taken right before submitting the email) so a stale code from a previous run is never picked.
- A store behind a storefront password sets a gate cookie; keycard clears the gate in a throwaway context and copies only cookies whose names are not already present, so authenticated cookies are never clobbered.
- Multi-shopper B2B: company contacts log in through the same code flow; the difference is what Shopify shows after login, not how. The `role` and `meta` fields on a shopper exist so tests can pick "the company admin" by name.

## 5. Challenge providers

| Provider | Backing | Notes |
|---|---|---|
| `testmail` | testmail.app JSON API, `livequery=false`, own 2s poll, 8s per-request abort, 60s deadline | Primary provider. The pool `prefix` groups shoppers by store. |
| `imap` | any IMAP mailbox with plus-addressing | Not implemented. |
| `human` | TTY prompt | Used for CAPTCHA escalation; disabled in CI unless `KEYCARD_ALLOW_HUMAN=1`. |

Bindings are ordered per shopper (default from the store: `[testmail, human]`); on timeout the next binding is tried.

## 6. Browser ladder

| Level | Launch | When | Human |
|---|---|---|---|
| `headless` | `chromium.launch({ headless: true })` | Default. Works for the code flow. | none |
| `headed` | `chromium.launch({ headless: false, channel: "chrome" })` | Retry when headless failed for a non-captcha reason. | none |
| `cdp` | `chromium.connectOverCDP("http://127.0.0.1:9222")` to a real Chrome the human started | hCaptcha on classic login. Human completes it; keycard saves state once `validate` passes. | yes |

A captcha detected at any level jumps straight to `cdp`, or fails with a clear message in CI.

## 7. Session store

- Location: `~/.keycard/sessions/{shopperId}.json.enc` (mode 600) plus `meta.json` (last code-send time per address, minted shoppers); `KEYCARD_SESSION_DIR` overrides; CI restores/saves the directory through the runner cache.
- Encryption: AES-256-GCM with `KEYCARD_KEY` (32 bytes base64). No key means refuse to write, never write plaintext.
- Validation is tri-state: `valid`, `invalid`, or `indeterminate`. A `valid` verdict is cached for 5 minutes so parallel workers stay fast. `indeterminate` (429, 408, 425, 5xx, timeout, network error, after two attempts with backoff) means the session is kept and used, because re-logging in would consume a login code and worsen the rate limit that caused the ambiguity. Only `invalid` triggers a new login. That default favours a suite that would rather run than stall; `KEYCARD_REQUIRE_CONFIRMED_SESSION=1` (or `requireConfirmed: true`) inverts it, so an unconfirmable session causes one fresh login attempt and then a hard `UnconfirmedSessionError` instead of being handed to a test. Probes for the same session are throttled to one per 15 seconds, and both caches live on the `Keycard` instance rather than in module state, so two configs in one process cannot affect each other.
- TTL: 7 days by default for named shoppers. Ephemeral shoppers get the same TTL; they are removed by `purgeEphemeral()` or `keycard clear --ephemeral`, not automatically at exit.
- Locking: an atomic `mkdir` lock directory per shopper id (no dependency), 3 minute stale timeout; waiters re-check the store after acquiring and return the leader's session.
- Cooldown: `lastChallengeAt` per address; a send inside `cooldownSeconds` waits, or fails fast if the wait would exceed the challenge timeout.
- Export: `keycard export --identity X --out ./.auth/X.json` writes plain Playwright storageState for tools that take a path. Plain exports are gitignored.

## 8. Surfaces and packaging

1. **CLI** `keycard`: `capture`, `validate`, `export`, `mint`, `otp`, `list`, `clear`, `refresh`, `doctor`, `mcp`.
2. **Node API**: section 3.3.
3. **Playwright fixture** `customer-account-keycard/playwright`: `test.extend({ shopper })` plus a `setup` project helper; the only place `@playwright/test` appears, as a peer dependency.
4. **MCP server** `keycard mcp`: `list_shoppers`, `mint_shopper`, `get_session`, `export_session`, `get_otp`.

Packaging: one package, generic core, `/playwright` subpath for the runner adapter. keycard has no runtime dependencies; at runtime it loads the consumer's `playwright`, else `@playwright/test`, else `playwright-core` (all optional peers), so it always drives the browsers the consumer already has installed. `yaml` and `@modelcontextprotocol/sdk` are optional peers loaded only for YAML config and `keycard mcp`. Canonical output is the Playwright storageState JSON; every other tool converts from it. A registry is not required:

| Mode | How | When |
|---|---|---|
| Git dependency (default) | `npm i -D github:aravindbaskaran/customer-account-keycard#v0.1.0`; `prepare` builds `dist/` | merchant projects want the fixture and CLI; no registry |
| Standalone CLI | `npx github:aravindbaskaran/customer-account-keycard capture ...` | consumers only need `.auth/*.json` and MCP |
| Local tarball | `npm pack` then `npm i -D ../customer-account-keycard-0.1.0.tgz` (a symlink would resolve keycard's own dev Playwright instead of yours) | iterating next to this repo |
| npm (public or GitHub Packages) | `npm i -D <name>` | only if people outside your machines need it to just work |

## 9. Secrets and identities

- `keycard.json` (or `identities.yaml` with the optional `yaml` package) holds stores, pools, named shoppers, and roles. It is found by walking up from cwd, or through `KEYCARD_CONFIG`.
- `SecretRef` forms: `env:NAME`, `op://vault/item/field`, `file:path`. Resolved lazily, never logged.
- Logger redacts resolved secrets and every code it handed out.
- Test shoppers only, on dev stores or explicitly authorized production stores. Ephemeral addresses carry the pool prefix so they can be found and cleaned up in Shopify Admin.

## 10. Operational notes

- Shopify rate-limits login code sends per address silently; the fix is session reuse plus cooldown plus minting a fresh address per scenario, not retries.
- After the hosted shopify.com login, Liquid `{% if customer %}` stays logged out until a plain storefront page (store root, not `/account`) is visited once.
- The storefront password gate cookie must be added without clobbering authenticated cookies of the same name.
- Load storageState onto the context, not cookie by cookie; the flow relies on localStorage as well as cookies.
- testmail: `livequery=false` and a per-request abort, or a poll can hang a minute.
- hCaptcha on storefront forms (classic login, contact, newsletter, blog comments) is invisible-score first, then a redirect to `/challenge`. Disable it on dev stores under Online Store > Preferences > Spam protection. The hosted new-customer-accounts code page is outside the theme and cannot be disabled; avoid abuse patterns and it does not trigger. keycard detects `/challenge` and captcha iframes and escalates to `cdp`.
- Test accounts in Shopify admin are identifiable only by email unless tagged through the Admin API: search `email:*@inbox.testmail.app`, or a segment `customer_email_domain = 'inbox.testmail.app'`. The README "Gotchas" section has the validated tag and delete mutations.
- A Shopify customer session does not automatically authenticate a third-party
  storefront SDK; verify that SDK's own authentication exchange separately.

## 11. Assumptions to confirm during Phase 1

- testmail.app remains the inbox of record; IMAP is a fallback only.
- Minted addresses under one namespace do not trip any per-namespace limit on Shopify's side (per-address limits are known; per-domain is not).
- Sessions can be cached in CI without violating a merchant policy; `KEYCARD_NO_CACHE=1` bypasses the cache and forces a fresh login if a merchant objects.

## 11a. Open-source posture

The package is MIT-licensed and has no runtime dependencies. See
`CONTRIBUTING.md` for the project boundaries and `SECURITY.md` for handling of
sessions, codes, and secrets.

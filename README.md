# customer-account-keycard

[![ci](https://github.com/aravindbaskaran/customer-account-keycard/actions/workflows/ci.yml/badge.svg)](https://github.com/aravindbaskaran/customer-account-keycard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/customer-account-keycard.svg)](https://www.npmjs.com/package/customer-account-keycard)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)

Cached Shopify customer-account sessions and test shoppers for headless tests.

## Latest: v0.3.1

The default decision engine is now the bundled offline `local-ranker`. It needs
no API key or network request, while procedural, Jev, and Laya remain available
as explicit modes. Login targets are filtered and revalidated against the
configured Shopify store, and Jev metadata is scrubbed before transmission.

[Read the full changelog](https://github.com/aravindbaskaran/customer-account-keycard/blob/main/CHANGELOG.md)

### Release verification status

The benchmark snapshot below measures control selection only. v0.3.1 is not
claimed as live end-to-end verified until the opt-in smoke suite passes through
both the ESM and CommonJS builds on an authorized password-protected test store.
The `shop.app` path remains a supported design path, not a current release
verification result. Other live observations in this README are historical and
do not replace that release gate.

## Documentation

[Read the documentation site](https://aravindbaskaran.github.io/customer-account-keycard/docs/)
[Browse the source documentation](docs/index.md)

For agencies and app developers testing Shopify surfaces behind a customer login. See the examples below.

New customer accounts use a 6-digit code emailed to the shopper. `keycard` reads that code from a test inbox, saves the resulting session encrypted, validates it before reuse, and supplies it to Playwright.

- Zero runtime dependencies. Uses the Playwright already in your project.
- ~80 KB compressed package. Node 22+.
- One command to log in, one call to get a logged-in `BrowserContext`, one call to mint a fresh shopper.

## Install

```bash
npm i -D customer-account-keycard
```

Requires `playwright` or `@playwright/test` in your project (any version >= 1.40; keycard drives the browsers you already have).

The bundled local account-component ranker is the default. It loads a trained
JSON model without an external package or API key, then ranks only controls that
pass the built-in domain gate. Jev and Laya are optional peers. Install Laya
only when using the local Laya engine:

```bash
npm install @receptron/laya
```

Jev needs no npm package; configure `TYPESAFE_API_KEY` and use
`decisionEngine: "jev"`. Playwright remains required for browser execution.

### Ranker validation snapshot

As of 2026-09-24, the shipped compact model had zero false positives and zero
false negatives in merchant-group holdouts of its independent label set (36
positive and 281 negative records). A separate read-only public-storefront
observation cohort selected an account entry or alternate authentication control
on 12 of 16 surfaces; two surfaces exposed no eligible control and two selected
an unrelated login-route control. That observation did not click, fill, submit,
request an OTP, or use credentials, so it is not an end-to-end login claim.

To run it once without adding it to the project:

```bash
npx --yes --package=customer-account-keycard keycard doctor
```

## Configure

Start with the example config and create a local session-encryption key. The
key is required because saved customer sessions are credentials.

```bash
cp node_modules/customer-account-keycard/config/keycard.example.json keycard.json
npx keycard init
```

`keycard init` creates or appends `KEYCARD_KEY` in `.env`, adds `.env` to
`.gitignore` when needed, never prints the key, and refuses to replace an
existing one. When it creates a new file, it also adds blank Testmail fields
for you to fill in. It uses Node's secure random source, so it works wherever
this package runs—OpenSSL is not required.

Then update `keycard.json` (no secrets in it):

```json
{
  "version": 1,
  "providers": { "testmail": { "apiKey": "env:TESTMAIL_API_KEY", "namespace": "env:TESTMAIL_NAMESPACE" } },
  "stores": [
    {
      "id": "demo",
      "flow": "shopify-customer-accounts",
      "storeUrl": "https://your-store.myshopify.com",
      "shopId": "100000000000",
      "storefrontPassword": "env:STOREFRONT_PASSWORD",
      "pool": { "provider": "testmail", "prefix": "demo" }
    }
  ],
  "shoppers": [
    { "id": "demo-owner", "store": "demo", "email": "ns.owner1@inbox.testmail.app", "role": "owner" }
  ]
}
```

`decisionEngine` controls how login controls are selected; Playwright always
performs the browser actions. The default `local-ranker` uses the bundled
offline trained account-component model. Use `procedural` for the legacy baseline,
`jev` for the TypeSafe cloud decision service, `laya` for the optional local
ONNX model, or `auto` to try Laya, then the local ranker.

### Why a decision engine

Storefront themes vary between account icons, links, modals, and hosted forms,
so one selector cannot safely identify login entry everywhere. The engine ranks
only visible, domain-valid account controls; it never receives secrets, reads an
inbox, requests an OTP, completes a CAPTCHA, creates a session, or acts in the
browser. Playwright performs and verifies every action. The bundled offline
model is the default; `auto` tries Laya then the local ranker. Jev is used only
when `decisionEngine: "jev"` is explicitly selected; it sends observed control
metadata to the approved TypeSafe endpoint, excluding surrounding page text and
URL query or fragment data.

The Jev model is configurable with `TYPESAFE_MODEL`; the default is the
official `jev-latest` alias. `jev-preview` is also available when returned by
`GET /v1/models`.

**Gitignore your `keycard.json`.** It names a real store and its test shoppers, and it is environment-specific, so it belongs next to that project's `.env` rather than in version control. Keep every credential in it as an `env:` reference, never as a literal, so that even a copy of the file leaks nothing; keycard rejects literal API keys and passwords. Commit `config/keycard.example.json` instead if your team needs a template.

`.env`:

```
TESTMAIL_API_KEY=...
TESTMAIL_NAMESPACE=ns
STOREFRONT_PASSWORD=...
```

See [.env.example](.env.example) for the non-secret environment template. For
AI decision-engine verification, add `TYPESAFE_API_KEY` for Jev or install
`@receptron/laya` for local Laya. Never put a real key in the
template or in `keycard.json`; use `env:` references and keep `.env` local.

### Live verification requirements

Live tests require an authorized development or test Shopify store, not a real
customer account. Provide:

- `KEYCARD_KEY`, generated with `npx keycard init`.
- Testmail API credentials and namespace for receiving OTPs.
- A `keycard.json` with the store's `storeUrl`, flow, optional numeric
  `shopId`, and an `env:` storefront-password reference when the store has a
  password gate.
- A dedicated test shopper whose email belongs to the configured Testmail
  namespace. Do not use a personal inbox or production customer.
- `TYPESAFE_API_KEY` only for Jev tests, or the Laya package and model cache
  for local inference.

The Shopify `shopId` is the numeric segment in the post-login URL such as
`shopify.com/<shopId>/account`; it is optional but makes session validation
stricter. Live verification remains opt-in and must use `KEYCARD_LIVE=1`.

When multiple stores are configured, live tests that mint shoppers must pass an
explicit `{ store: "store-id" }`; the test fixture cannot infer a default.

`shopId` is the number in `shopify.com/<shopId>/account` after a login; optional but makes validation stricter. `storefrontPassword` is only needed on password-protected stores. YAML config works too if you install the optional `yaml` package.

### Upgrading from 0.1.x

The 0.3.0 login flow starts at the storefront home page, clears a storefront
password gate when configured, and discovers the account entry before opening
the hosted login form. `decisionEngine: "procedural"` selects the legacy
control-selection baseline; it does not promise to restore the old navigation
path. Re-run the opt-in live smoke suite against your authorized test store
before upgrading a release pipeline.

## Use

CLI:

```bash
npx keycard doctor                                   # config, key, inbox, browser
npx keycard capture --identity demo-owner            # log in (or reuse the cached session)
npx keycard export  --identity demo-owner --out .auth/demo-owner.json
npx keycard mint    --role gifter                    # fresh shopper address, no login yet
npx keycard otp     --identity demo-owner            # wait for and print the next code
npx keycard list | validate | clear | refresh | mcp
```

Plain Playwright scripts:

```js
const { withShopper, withShoppers, mint } = require("customer-account-keycard");

await withShopper("demo-owner", async (context) => {
  const page = await context.newPage();
  await page.goto("https://your-store.myshopify.com/account");
});

await withShoppers({ owner: "demo-owner", gifter: await mint("gifter") }, async ({ owner, gifter }) => {
  // two contexts, two real customers, no shared cookies
});
```

`@playwright/test`:

```ts
import { test, expect } from "customer-account-keycard/playwright";
test.use({ shopperId: "demo-owner" });
test("starts logged in", async ({ page }) => {
  await page.goto("https://your-store.myshopify.com/account");
  await expect(page).toHaveURL(/shopify\.com\/\d+\/account/);
});
```

Agents (MCP): add `{ "command": "npx", "args": ["keycard", "mcp"] }` to your MCP config (needs the optional `@modelcontextprotocol/sdk`). Tools: `list_shoppers`, `mint_shopper`, `get_session`, `export_session`, `get_otp`.

## How the login works

1. Opens the storefront, clears the password gate if any, clicks the header account button, and submits the email through the theme's `<shopify-account>` popover. This lands directly on the hosted code page and skips the "Sign in with Shop" hop. Themes without the popover fall back to `/account/login`.
2. Polls the inbox for the code sent after the submit timestamp, enters it, and waits to land back on the store.
3. Saves the whole context's `storageState` (cookies on both the store and `shopify.com`, plus localStorage), encrypted with `KEYCARD_KEY`.
4. Before every hand-out, validates with one GET to `/account` (browser-like headers) and re-logs in only if the session is **definitively** dead or expired (7 days by default). A 429, a 5xx or a network error is treated as "cannot tell right now", and the session is kept, because logging in again would burn a login code and feed the very rate limit that caused the ambiguity. `keycard validate` reports that state as `UNCONFIRMED` and exits 0.

Minted shoppers are `{namespace}.{prefix}-{role}-{id}@inbox.testmail.app`; Shopify creates the customer on first code login, so a fresh shopper costs nothing to provision.

## Environment

| Variable | Purpose |
|---|---|
| `KEYCARD_KEY` | required; 32-byte base64 key for sessions at rest |
| `KEYCARD_CONFIG` | config path (default: `keycard.json` / `identities.yaml` found upward from cwd) |
| `KEYCARD_SESSION_DIR` | default `~/.keycard/sessions` |
| `KEYCARD_ALLOW_HUMAN=1` | allow the TTY/human fallback and the `cdp` level outside an interactive shell |
| `KEYCARD_CDP_URL` | default `http://127.0.0.1:9222` for the `cdp` level |
| `KEYCARD_LOG` | `debug` or `silent` |
| `KEYCARD_NO_CACHE=1` | ignore any saved session and log in fresh; the new session is still encrypted and saved |
| `KEYCARD_REQUIRE_CONFIRMED_SESSION=1` | never hand out a session that was not positively confirmed in this run. An unconfirmable session triggers one fresh login, and if that still cannot be confirmed keycard fails with `UnconfirmedSessionError` rather than returning it |
| `KEYCARD_ARTIFACTS=1` | on failure, save a full-page screenshot to `KEYCARD_ARTIFACT_DIR`. Off by default: a screenshot of the code screen contains a live login code |
| `TYPESAFE_API_KEY` | optional Jev cloud credential used only by explicit `decisionEngine: "jev"` |
| `TYPESAFE_MODEL` | Jev model name returned by `GET /v1/models`; defaults to `jev-latest` |
| `TYPESAFE_API_URL` | optional TypeSafe API path override on `https://api.typesafe.ai`; defaults to `/v1/systemone` |
| `KEYCARD_JEV_TIMEOUT_MS` | optional Jev request timeout; defaults to 15,000 ms and is clamped to 1,000-60,000 ms |
| `LAYA_CACHE` | optional cache directory for the local Laya ONNX model; defaults to `~/.cache/receptron-laya` and first use downloads about 1.7 GB |
| `KEYCARD_MCP_SHOPPERS` | comma-separated named shoppers the MCP server may act on. Minted shoppers are always allowed |
| `KEYCARD_MCP_ALLOW_NAMED=1` | let the MCP server act on every named shopper |
| `KEYCARD_MCP_ALLOW_RAW_SESSION=1` | let MCP `get_session` return cookies inline instead of metadata only |
| `KEYCARD_MCP_EXPORT_ROOT` | directory MCP `export_session` may write into (default `./.auth`) |

## For Shopify agencies and app developers

The problem this solves is the same whether you build themes, apps or storefronts: anything behind a customer login cannot be tested headlessly, because new customer accounts email a fresh 6-digit code on every sign-in. The usual workarounds (one mailbox per tester, `qa+1@`, `qa+2@` sprawl, or a shared account whose codes land in someone's personal inbox) do not survive more than a handful of scenarios. keycard turns a login into a cached artifact and an inbox namespace into an unlimited supply of shoppers.

### Agency: many clients, one suite

One `keycard.json` per client project, or one file with every store. Each store gets its own inbox `prefix`, so a client's test customers are identifiable in that client's admin and never collide with another client's.

```json
{
  "version": 1,
  "providers": { "testmail": { "apiKey": "env:TESTMAIL_API_KEY", "namespace": "env:TESTMAIL_NAMESPACE" } },
  "stores": [
    { "id": "acme-dev",  "flow": "shopify-customer-accounts", "storeUrl": "https://acme-dev.myshopify.com",  "storefrontPassword": "env:ACME_DEV_PASSWORD", "pool": { "provider": "testmail", "prefix": "acme-dev" } },
    { "id": "acme-prod", "flow": "shopify-customer-accounts", "storeUrl": "https://acme.com", "pool": { "provider": "testmail", "prefix": "acme-prod" }, "ttlHours": 24 },
    { "id": "globex",    "flow": "shopify-customer-accounts", "storeUrl": "https://globex.myshopify.com", "pool": { "provider": "testmail", "prefix": "globex" } }
  ],
  "shoppers": [
    { "id": "acme-loyalty-member", "store": "acme-dev", "email": "ns.acme-dev-loyalty@inbox.testmail.app", "role": "member", "smoke": true }
  ]
}
```

Run the same scenario across every client store:

```js
const { keycard, mint, withShopper } = require("customer-account-keycard");

const kc = await keycard();
for (const store of Object.values(kc.config.stores)) {
  const shopper = await mint("checkout", { store: store.id });
  await withShopper(shopper, async (context) => {
    const page = await context.newPage();
    await page.goto(`${store.storeUrl}/account`);
    // assert the client's account page renders what the build promised
  });
}
```

Why this matters for client work: you never ask a client for a real customer's credentials, and you never have to keep a shared test login's codes flowing through someone's personal mailbox. The shoppers live in your inbox namespace, and the client can find them in their own admin with `email:*@inbox.testmail.app` (see Gotchas).

### Agency: theme QA against a preview, not the published theme

Sessions are independent of which theme renders, so capture once and drive an unpublished theme:

```js
await withShopper("acme-loyalty-member", async (context) => {
  const page = await context.newPage();
  await page.goto(`${STORE}/?preview_theme_id=${THEME_ID}`);   // once per context
  await page.goto(`${STORE}/account`);                          // stays in preview and stays signed in
});
```

Historical observation, not a v0.3.0 release gate: the session survived the preview navigation and following page loads (checked with the published theme's own id, because this store has no second theme). Shopify strips `preview_theme_id` from the URL after the first navigation, so pass it once per context rather than on every `goto`, and assert `window.Shopify.theme.id` if the test must prove which theme it is exercising.

### App developers: surfaces that need a signed-in customer

| Surface | Pattern |
|---|---|
| Customer account UI extensions | The saved session covers both the store origin and `shopify.com`, so navigating to `{storeUrl}/account` lands on `shopify.com/{shopId}/account...` already authenticated, which is where your extension renders. Verified. |
| App proxy routes (`/apps/<subpath>/...`) | Call them from inside the authenticated page, or from plain `fetch` with `toCookieHeader(session, url)`. Both send the same cookies and get the same response, so a proxy route can be probed without a browser. |
| Theme app extension blocks behind `{% if customer %}` | The flow ends on the store origin specifically so `_shopify_essential` is set there and Liquid sees the customer. A session captured but never landed back on the store domain renders logged out. |
| Storefront API carts tied to a customer | Use the session's cookies for the storefront request, or drive it from the authenticated page. |

```js
const { getSession, toCookieHeader } = require("customer-account-keycard");

const session = await getSession("acme-loyalty-member");
const url = `${STORE}/apps/my-app/loyalty/balance`;
const res = await fetch(url, { headers: { Cookie: toCookieHeader(session, url), Accept: "application/json" } });
```

Historical observation on a live app-proxy route, not a v0.3.0 release gate: the routed request behaved identically in-browser and via `toCookieHeader` (same status, same body). The route we probed returns 500 for a bare GET, so this confirms cookie parity and routing, not a successful auth exchange on that particular endpoint.

### Multi-shopper scenarios

```js
const { withShoppers, mint } = require("customer-account-keycard");

// isolation: B must not see A's data
await withShoppers({ a: await mint("shopper-a"), b: await mint("shopper-b") }, async ({ a, b }) => {
  const pa = await a.newPage();
  const pb = await b.newPage();
  // create something as A, then assert it is invisible to B
});

// two roles in one journey
await withShoppers({ owner: "acme-registry-owner", gifter: await mint("gifter") }, async ({ owner, gifter }) => {
  // owner creates a registry, gifter buys from it, in one run, no cookie bleed
});
```

Each shopper gets its own `BrowserContext` in one browser, so there is no cookie bleed and no logout/login dance between actors. Verified live with two shoppers holding distinct `_shopify_essential` values.

A guest-to-customer merge test (create as a guest, then sign in, then assert the guest's data moved to the account) is the other pattern this enables: do the guest work in a plain `browser.newContext()`, then hand the same context a session, or navigate that context through the login yourself using `getOtp`.

B2B company contacts sign in through the same code flow, so the same calls apply; what differs is what Shopify renders afterwards. Use `role` and `meta` to label which shopper is the company admin and which is the location buyer. Not exercised here, so treat the B2B specifics as untested.

### Agent-driven QA

For an agent doing exploratory or regression testing with Playwright MCP, either hand it a pre-authenticated browser:

```json
{ "mcpServers": {
  "keycard":    { "command": "npx", "args": ["keycard", "mcp"], "cwd": "." },
  "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--storage-state", ".auth/acme-loyalty-member.json"] }
} }
```

or let it drive the login itself: `mint_shopper` for a fresh customer, submit the email on the storefront, then `get_otp(shopper, since)` for the code. Both were exercised live. Needs `@modelcontextprotocol/sdk` installed in the project running the server.

**The MCP server is locked down by default, because an agent reading a poisoned page should not be able to hand out your sessions.** Out of the box it acts only on minted (throwaway) shoppers, `get_session` returns metadata rather than cookies, and `export_session` can only write `.json` files inside `./.auth`. Opening any of that up is an explicit environment variable (see Environment), and `list_shoppers` reports the active policy so an agent can see what it is allowed to do.

### CI

Use a scheduled refresh job for logins and let test jobs consume cached sessions. This reduces rate-limit failures during test runs.

```yaml
# nightly (or pre-suite): the only job that logs in
- run: npx keycard refresh --expiring-within 24h
# test jobs: restore the same session cache, then
- run: npx keycard export --identity acme-loyalty-member --out .auth/acme-loyalty-member.json
- run: npx playwright test
```

Set `KEYCARD_KEY`, `TESTMAIL_API_KEY` and `TESTMAIL_NAMESPACE` as secrets, cache `KEYCARD_SESSION_DIR`, and leave `KEYCARD_ALLOW_HUMAN` unset so a flow that needs a human fails loudly instead of hanging. Minted shoppers are per-run by design; do not cache them.

### Stakeholder demos and app review recordings

Use named shoppers for demos and recordings that need stable history. `capture` reuses their sessions when available.

## Verification status

Live-verified on 2026-09-17 against an authorised development store (new customer accounts, storefront password on, Playwright 1.62.1, Node 22.22, macOS):

| Path | Result |
|---|---|
| `capture` headless, named shopper | real popover login + real emailed code, 18s |
| `capture` again (cache) | 4s, one validation GET, no code sent |
| `capture` while shopify.com was returning 429 | session kept and reused in 4.8s, no login attempted, `UNCONFIRMED` reported |
| `capture --level headed` | Chrome window, 20s |
| `capture --level cdp` | refuses without a human; with `KEYCARD_ALLOW_HUMAN=1` attaches to Chrome on `:9222` and logs in, 19s |
| `validate` / `export` / `list` / `mint` / `clear --ephemeral` | export loads in `test.use({ storageState })` |
| `otp` CLI and MCP `get_otp` | returned the live code 3s after the form submit |
| `refresh` | captures when missing, `kept` when fresh, re-captures with `--expiring-within 200h`, waits out the 120s cooldown, rejects a bad duration |
| `withShopper` / `withShoppers` / `mint` / `purgeEphemeral` | two live shoppers, distinct `_shopify_essential` per context |
| `@playwright/test` fixture | spec passed, 8s |
| MCP server | `initialize`, `tools/list`, `list_shoppers`, `get_otp` over stdio |
| `clear --orphans` | removed a session file left behind by an older naming scheme |
| Cooldown, captcha escalation, `KEYCARD_ALLOW_HUMAN` guard, `KEYCARD_KEY` refusal, inbox tag isolation, cross-project session scoping, file permissions, MCP policy, indeterminate validation | covered by offline tests plus the live runs above |

Repeat it with `npm run test:live` (needs `KEYCARD_CONFIG` pointing at a real store config, and `KEYCARD_LIVE=1`).

**Experimental, not verified:** `shopify-classic-customer`. Selecting it logs a warning. It needs a store with classic customer accounts enabled; `demo-store` serves `/account/register` as a redirect to shopify.com, which means new customer accounts. Its `selectors.ts` says so. Treat that flow as untested code until it runs against a classic store.

## Gotchas

**Rate limits.** Shopify silently rate-limits code sends per address. Reuse sessions (the default), keep named shoppers for demos and recordings, and `mint` for scenarios. keycard enforces a per-address cooldown (120s) and never retries a code send in a loop.

**Captcha.** Shopify runs hCaptcha on storefront customer, contact and blog-comment forms: an invisible score first, then a redirect to `/challenge` if the visitor looks suspicious or sends too many requests in a short window. keycard never solves it. It detects the `/challenge` page or a captcha iframe, jumps to the `cdp` level (a human completes it in a real Chrome, keycard saves the result), or fails with the reason in CI.

- Classic accounts (`shopify-classic-customer`): the login form is a storefront form, so hCaptcha applies. On dev and test stores turn it off in Shopify admin: Online Store > Preferences > Spam protection (per Shopify's own docs, merchants can disable hCaptcha there).
- New customer accounts (`shopify-customer-accounts`): the code page is hosted on shopify.com, outside the theme, and the merchant cannot disable its bot protection. In practice it only triggers on abuse patterns: many code requests from one IP in minutes, or automation hammering one address. Session reuse plus minted addresses keeps you well under that.
- The popover email step is not a Liquid form, but the storefront newsletter/contact forms are; do not let scripts touch those (an `input[type=email]` selector on the home page finds the newsletter form before the popover).

**Which customers in Shopify admin are test accounts?** keycard cannot tag customers on its own (it has no Admin API access), so the marker is the email. Every shopper keycard creates lives under the testmail domain and starts with your pool prefix: `{namespace}.{prefix}-{role}-{id}@inbox.testmail.app`. Ways to find them:

| Where | Query |
|---|---|
| Admin > Customers search box, Admin GraphQL `customers(query:)`, REST `customers/search` | `email:*@inbox.testmail.app` (documented wildcard-domain search). Narrow to one store's pool by eye on the local part, e.g. `ns.demo-` vs `ns.demob-`. |
| Admin > Customers > Segments (saved, live count, bulk actions) | `customer_email_domain = 'inbox.testmail.app'` |
| After tagging (below) | search `tag:keycard`, segment `customer_tags CONTAINS 'keycard'` |
| Locally | `keycard list` prints every named and minted shopper with its email; `keycard list --ephemeral` only the minted ones |

If you want a stronger marker than the email, add tags with an Admin API token (`write_customers`). A future `provision` hook will do this from keycard; until then a short script does:

```graphql
query KeycardTestShoppers($q: String!, $cursor: String) {
  customers(first: 250, query: $q, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id email createdAt tags numberOfOrders }
  }
}
# variables: { "q": "email:*@inbox.testmail.app" }

mutation KeycardTagShopper($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}
# variables: { "id": "gid://shopify/Customer/...", "tags": ["keycard", "keycard:ephemeral"] }

mutation KeycardDeleteShopper($id: ID!) {
  customerDelete(input: { id: $id }) { deletedCustomerId userErrors { field message } }
}
```

Suggested tags: `keycard` on everything, `keycard:ephemeral` on minted shoppers, `keycard:store:<store id>`. Do not delete named shoppers; recordings and demos depend on their history. Customers with orders cannot be deleted through the API; archive them or leave them tagged.

**Sign in with Shop.** If a store's direct `/account/login` route goes through "Sign in with Shop", `shop.app` must be reachable from the test machine; keycard detects a stall there and fails fast with the reason. The popover path (the default) does not depend on `shop.app`. Some networks block or hijack `shop.app` at the DNS level; check with `dig shop.app` against a public resolver if the fallback path stalls.

**Validation is deliberately not binary.** shopify.com rate-limits the account redirect chain, so a probe can fail while the session is perfectly good (a real browser still gets in). keycard distinguishes "dead" from "cannot tell": only a definitive answer causes a new login. If you see repeated `UNCONFIRMED`, you are probing too often, not losing sessions; slow down and let the positive verdict cache (5 minutes) do its job.

By default an `UNCONFIRMED` session is returned. Set `KEYCARD_REQUIRE_CONFIRMED_SESSION=1` (or use `--strict` / `requireConfirmed: true`) to fail instead. `keycard validate --strict` exits 1 for `UNCONFIRMED`.

**Sessions.** They are only as valid as Shopify says: `validate` is a real request, not a cookie check. Plain exports in `.auth/` are unencrypted; keep them gitignored and short-lived.

## Acceptable use

Run keycard only against stores you own or are explicitly authorised to test, with test shoppers you created. This is also your inbox provider's rule: testmail.app's terms prohibit using their mailboxes to create accounts on third-party services in a way that violates those services' terms, and require the store owner's permission before load-testing signups. keycard contains no CAPTCHA solving, no fingerprint spoofing, and no session forging, and will not accept contributions adding them.

## License, credits and thanks

MIT, see [LICENSE](LICENSE).

keycard uses [Playwright](https://playwright.dev) and can read login codes through
[testmail.app](https://testmail.app). See [CREDITS.md](CREDITS.md) for links,
references, and contributor acknowledgements.

[CREDITS.md](CREDITS.md) has the full thanks, the references worth reading, and the contributor list. Also [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [CHANGELOG.md](CHANGELOG.md).

Maintainers: [PUBLISHING.md](PUBLISHING.md) is the release runbook.

## Docs

- [docs/DESIGN.md](docs/DESIGN.md): what it is, the model, the flows, and every gotcha found live.
- [docs/SETUP.md](docs/SETUP.md): repo layout, configuration reference, and how merchant projects consume it.

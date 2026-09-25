# customer-account-keycard: detailed setup and run instructions

Detailed setup for package contributors and projects that consume it. For the
short installation guide, use the [README](../README.md); release procedure and
quality requirements live in [PUBLISHING.md](../PUBLISHING.md) and
[QUALITY.md](QUALITY.md).

Package manager: npm or pnpm both work; scripts use `npm run`. The live verification used npm.

## 1. Prerequisites

- Node 22 via nvm, first on `PATH`. Do not export `CI=1` in a shell you also use for Shopify CLI.
- Google Chrome installed for the `headed` and `cdp` levels. Playwright's bundled Chromium is enough for `headless`.
- testmail.app account: API key and namespace.
- A 32-byte session key: `openssl rand -base64 32` -> `KEYCARD_KEY`.

## 2. Package repo

```bash
git clone aravindbaskaran/customer-account-keycard && cd customer-account-keycard
npm install                 # dev deps only: typescript 5, tsup, tsx, vitest, playwright, @playwright/test, yaml, MCP SDK
npm run build               # dist/ (esm + cjs + d.ts, code-split, ~110 KB of JS, ~81 KB tarball)
npm run test:unit           # offline unit tests; no network or browser launch
npm pack                    # tarball for local installs
```

Runtime dependencies: none. Optional peers: `playwright` / `@playwright/test` / `playwright-core` (one of them is required at runtime), `yaml` (YAML config), `@modelcontextprotocol/sdk` (`keycard mcp`).

## 3. Repo layout

```
customer-account-keycard/
  src/
    index.ts                 getSession, exportSession, withShopper, withShoppers, mint, getOtp, toCookieHeader
    cli.ts
    core/
      types.ts
      config.ts              keycard.json (or identities.yaml) + .env, hand-validated
      secrets.ts             env: / op:// / file: resolvers
      pool.ts                mint(), address formats per pool provider
      session-store.ts       encrypt, ttl, lock, cooldown, validate cache
      ladder.ts              headless / headed / cdp, captcha detection
      acquire.ts             DESIGN 3.1
      logger.ts              dependency-free logger with secret redaction
    providers/
      testmail.ts  human.ts  index.ts
    flows/
      shopify-customer-accounts/{index.ts,selectors.ts}
      shopify-classic-customer/{index.ts,selectors.ts}
      index.ts
    playwright/index.ts      fixture + setup project helper
    mcp/server.ts
  config/identities.example.yaml
  test/unit/  test/live/
  docs/flows/<flow-id>.md    screens, selectors, verifiedOn
```

## 4. Configuration

`keycard.json` (not committed; YAML works too with the optional `yaml` package):

```json
{
  "version": 1,
  "providers": {
    "testmail": { "apiKey": "env:testmail_api_key", "namespace": "env:testmail_namespace" }
  },
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
    { "id": "demo-owner", "store": "demo", "email": "ns.demo-owner@inbox.testmail.app", "role": "owner", "smoke": true }
  ]
}
```

Rules:

- **Gitignore this file.** It is environment-specific and names a real store; add `keycard.json` to the consuming project's `.gitignore`. Credentials in it must be `env:` references, never literals: `"storefrontPassword": "env:STOREFRONT_PASSWORD"`, not the password itself.
- A shopper with no `challenges` inherits `[testmail(tag = local part after the namespace), human]`.
- Optional per-store keys: `ttlHours` (168), `cooldownSeconds` (120), `ladder` (`["headless","headed","cdp"]`); the same keys under `defaults` apply to every store. `challengeTimeoutMs` (90000) under `defaults`.
- `mint(role, { store })` needs only the store's `pool`; it produces `{namespace}.{prefix}-{role}-{shortid}@inbox.testmail.app` and a shopper id `{store}:mint:{role}-{shortid}`.
- Named shoppers are for demos and recordings that must show a stable name and history. Scenario tests should mint.

`.env` (gitignored):

```
KEYCARD_KEY=<base64 32 bytes>
TESTMAIL_API_KEY=...
TESTMAIL_NAMESPACE=ns
STOREFRONT_PASSWORD=...
DEMO_B_STORE_URL=https://another-store.myshopify.com
SECOND_STOREFRONT_PASSWORD=...
```

## 5. Where things are

| Path | What |
|---|---|
| `src/index.ts` | public API: `keycard`, `getSession`, `exportSession`, `getOtp`, `mint`, `withShopper`, `withShoppers`, `toCookieHeader`, `purgeEphemeral` |
| `src/cli.ts` | `keycard` CLI on `util.parseArgs` |
| `src/core/acquire.ts` | DESIGN 3.1: cache, validate, lock, cooldown, ladder, save |
| `src/core/session-store.ts` | AES-256-GCM at rest, mkdir lock, `meta.json` |
| `src/core/config.ts` | JSON (or YAML) config loader and validator, `.env` loading, default challenge bindings |
| `src/core/pool.ts` | `mintShopper` |
| `src/core/pw.ts` | loads the consumer's Playwright (`playwright` > `@playwright/test` > `playwright-core`) |
| `src/flows/shopify-customer-accounts/` | popover-first login, hosted fallback, validation; `selectors.ts` with `verifiedOn` |
| `src/flows/shopify-classic-customer/` | password login; unverified |
| `src/flows/shared.ts` | password gate, captcha detection, `gotoLogin` with `shop.app` stall detection |
| `src/providers/` | `testmail`, `human`. An `imap` provider is wanted but not written. |
| `src/playwright/index.ts` | `test.use({ shopperId })` fixture, `setupShoppers` |
| `src/mcp/server.ts` | MCP tools over stdio, SDK loaded lazily |

## 6. Running the new repo

```bash
cd /path/to/your/project      # keycard.json and .env live here
npx keycard doctor
npx keycard capture  --identity demo-owner
npx keycard validate --identity demo-owner
npx keycard export   --identity demo-owner --out .auth/demo-owner.json
npx keycard mint     --role gifter                              # prints id + email, no login yet
npx keycard capture  --identity demo:mint:gifter-1a2b3c4d
npx keycard otp      --identity demo-owner --since $(date +%s000)
npx keycard clear    --ephemeral
```

Captcha escalation (classic accounts, Phase 3):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.keycard/chrome" &
npx keycard capture --identity some-classic-shopper --level cdp
```

Live smoke test: `npm run test:live` (gated on `KEYCARD_LIVE=1`; it requires an authorised development or test store and dedicated test shoppers).

## 7. Consuming from merchant projects

Install the published package with the Playwright package your project already
uses:

```bash
npm i -D customer-account-keycard @playwright/test
cp node_modules/customer-account-keycard/config/keycard.example.json keycard.json
npx keycard init
```

Set the Testmail values and your store URL in local `.env` and `keycard.json`,
then verify the setup before writing a test:

```bash
npx keycard doctor
npx keycard capture --identity demo-owner
```

For local package iteration, install a tarball rather than a symlink so keycard
resolves the consuming project's Playwright:

```bash
(cd ../customer-account-keycard && npm pack)
npm i -D ../customer-account-keycard/customer-account-keycard-0.3.0.tgz
```

Keep one `keycard.json` next to each consuming project's `.env`, or pass a
shared configuration explicitly with `--config`. Do not commit either file.

Playwright config with a setup project:

```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "storefront", dependencies: ["setup"], use: { storageState: ".auth/demo-owner.json" } },
  ],
});
```

`auth.setup.ts`:

```ts
import { test as setup } from "@playwright/test";
import { exportSession } from "customer-account-keycard";
setup("sessions", async () => {
  await exportSession("demo-owner", ".auth/demo-owner.json");
});
```

Recording script:

```js
const { withShopper } = require('customer-account-keycard');
await withShopper('demo-owner', async (context) => {
  const page = await context.newPage();
  await page.goto('https://your-store.myshopify.com/account');
}, { headless: false, recordVideo: { dir: 'videos', size: { width: 1280, height: 800 } } });
```

Two-shopper scenario (owner creates, gifter buys):

```js
const { withShoppers, mint } = require('customer-account-keycard');
await withShoppers({ owner: mint('owner', { store: 'demo-b' }), gifter: mint('gifter', { store: 'demo-b' }) }, async ({ owner, gifter }) => {
  const ownerPage = await owner.newPage();
  const gifterPage = await gifter.newPage();
});
```

## 8. Agent use through MCP

`mcp.json`:

```json
{
  "mcpServers": {
    "keycard": { "command": "npx", "args": ["keycard", "mcp", "--config", "keycard.json"] },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--storage-state", ".auth/demo-owner.json"] }
  }
}
```

Two ways an agent uses it:

1. Pre-authenticated: `export_session("demo-owner", ".auth/...json")`, then start Playwright MCP with `--storage-state`. Every page is already logged in.
2. Drive the login yourself: `mint_shopper("demo", "buyer")`, open `/account/login` with Playwright MCP, note the time, submit the email, call `get_otp(shopperId, since)`, type the code.

## 9. Security checklist

- `KEYCARD_KEY` only in local `.env` and CI secrets.
- `.auth/` plain exports are gitignored and deleted at the end of every run.
- Test shoppers only; minted addresses carry the pool prefix so they are findable in Shopify Admin for cleanup.
- Logs redact codes and passwords. Traces are local only.
- No automation of captchas; `cdp` plus a human is the answer.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no code within 60000ms` right after a capture that worked minutes ago | Shopify rate limit on code sends to that address | wait, or `mint` a fresh shopper; stop using `--force` on named shoppers |
| Logged in on shopify.com but Liquid `customer` is empty | store-domain bridge missing | `postLogin` must visit the store root, not `/account`; check the storefront password cleared the gate |
| Password gate reappears after loading a session | gate cookie not carried | keycard adds only missing-by-name cookies; confirm the store has `storefrontPassword` |
| Two shoppers see each other's state | contexts shared cookies | use `withShoppers` (one context per shopper), never `page.context()` reuse |
| Minted shopper's code never arrives | testmail tag-filter mismatch | the `tag` in `challenges.options` must equal the local part after `{namespace}.` |
| hCaptcha on classic login | too many attempts from one IP | stop retrying; capture once via `cdp`, rely on the cached session |
| `refuse to save: KEYCARD_KEY unset` | intended | set the key |

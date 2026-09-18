# Credits, references and thanks

## Thanks

### testmail.app

[testmail.app](https://testmail.app) provides the inbox API used by the built-in
provider. Its `{namespace}.{tag}@inbox.testmail.app` addressing and JSON API
filters (`tag`, `timestamp_from`) support isolated login-code retrieval.

Links: [docs](https://testmail.app/docs/), [status](https://status.testmail.app/),
[@testmailapp on X](https://x.com/testmailapp),
[GitHub](https://github.com/testmail-app), and support@testmail.app.

This project is not affiliated with or endorsed by testmail.app. Additional
providers are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

### Playwright

keycard is a thin layer over [Playwright](https://playwright.dev). It drives the browsers your project already has and never bundles its own, which is only possible because Playwright's `storageState` is a clean, portable representation of a logged-in session, and because `request.newContext({ storageState })` lets a session be validated with one HTTP request instead of a browser launch.

### Shopify

The [Shopify developer documentation](https://shopify.dev) was the source of truth for the CAPTCHA behaviour, customer search syntax and segment query language that keycard relies on. Specific pages are listed under References.

### Prior art

- Playwright's [authentication guide](https://playwright.dev/docs/auth) describes the `storageState` reuse pattern used by keycard.

## References

Everything keycard depends on that is worth reading yourself.

### Shopify

- [Customer accounts](https://help.shopify.com/en/manual/customers/customer-accounts) and the new customer accounts login flow (email code, no password).
- [CAPTCHA](https://shopify.dev/docs/storefronts/themes/trust-security/captcha): hCaptcha on customer, contact and blog comment forms, the invisible score, the `/challenge` redirect, and that merchants can disable it under Online Store > Preferences.
- [Customer segment query language](https://shopify.dev/docs/apps/build/shopifyql/segment-query-language-reference): `customer_email_domain = '...'` for finding your test shoppers.
- Admin API [`customers`](https://shopify.dev/docs/api/admin-graphql/latest/queries/customers) query with `query: "email:*@inbox.testmail.app"`, [`tagsAdd`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd) and [`customerDelete`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/customerDelete) for labelling and cleaning up test customers.
- [Customer Account UI extensions](https://shopify.dev/docs/api/customer-account-ui-extensions): the surface most app developers want a logged-in session for.
- [App proxy](https://shopify.dev/docs/apps/build/online-store/display-dynamic-store-data): the routes you can probe with `toCookieHeader`.

### testmail.app

- [JSON API reference](https://testmail.app/docs/#json-api-reference): `https://api.testmail.app/api/json` with `apikey`, `namespace`, `tag`, `tag_prefix`, `timestamp_from`, `livequery`, `limit`.
- [Terms of service](https://testmail.app/terms/): read the acceptable use section before pointing any test suite at a store you do not own.
- [Pricing](https://testmail.app/pricing/)

### Playwright

- [Authentication](https://playwright.dev/docs/auth), [`browserContext.storageState()`](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state), [test project dependencies](https://playwright.dev/docs/test-projects), [`connectOverCDP`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) for the `cdp` level.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp): `--storage-state` is how an agent gets a pre-authenticated browser from keycard.

### Standards and tools

- [Model Context Protocol](https://modelcontextprotocol.io) for the `keycard mcp` server.
- AES-256-GCM via Node's [`crypto`](https://nodejs.org/api/crypto.html), `util.parseArgs` for the CLI, and [tsup](https://tsup.egoist.dev) plus [vitest](https://vitest.dev) for build and tests. No runtime dependencies.

## Contributors

keycard is maintained by [Aravind Baskaran](https://github.com/aravindbaskaran) (`@aravindbaskaran`).

This project was human-designed and human-reviewed. AI-assisted tools were
used during implementation and documentation; the maintainer is responsible for
the code and releases.

Contributions of any size are credited here. If you send a pull request, add yourself in the same commit; if you forget, a maintainer will add you on merge. See `CONTRIBUTING.md`.

<!-- Add new contributors below, newest last. -->

- Aravind Baskaran: initial design, implementation, and live verification against a Shopify development store.

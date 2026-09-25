# Changelog

All notable changes are documented here. This project follows semantic versioning.

## [0.3.1] - 2026-09-25

### Fixed

- CommonJS browser-evaluated callbacks no longer contain bundler-generated
  helpers that are unavailable inside a Playwright page.
- Storefront password submission waits for the redirect away from `/password`
  before the login flow navigates again.
- Login errors preserve the root failure before reporting that CDP escalation
  needs a human, and propagated store hosts are redacted consistently.

### Verification

- Added offline regression coverage for password redirects, error ordering, and
  store-host redaction.
- Added an opt-in live smoke test that forces a login through the published
  CommonJS build. It still requires an authorized test store and `KEYCARD_LIVE=1`.

## [0.3.0] - 2026-09-25

### Potentially breaking behavior changes

- The customer-account login flow now begins at the storefront home page and
  discovers the account entry before opening the hosted login form. Integrations
  that depended on direct `/account/login` navigation or intermediate page state
  should review this change before upgrading from 0.1.x. `decisionEngine:
  "procedural"` restores the legacy control-selection baseline, not necessarily
  the previous navigation path.
- The default decision engine is now the bundled offline `local-ranker` rather
  than the procedural baseline. Select `decisionEngine: "procedural"` when the
  legacy selector behavior is required.

These are behavior changes, not removals of the public API. They are called out
explicitly because this project is still below 1.0 and the 0.3.0 login path can
affect storefront-specific integrations.

### Changed

- The default decision engine is now `local-ranker`, a bundled offline model
  that ranks visible account, email, and one-time-code controls. It requires no
  API key or network request. Procedural, Jev, and Laya remain explicit modes.
- The ranker is trained from Playwright-confirmed control labels and uses page
  metadata such as labels, roles, names, autocomplete values, destinations, and
  nearby form context. It filters unrelated controls before scoring candidates
  and fails closed when no safe target is available.
- The initial discovery step now finds the storefront account entry before
  narrowing observation to the active authentication form. Carousel, search,
  cart, newsletter, product, cookie, consent, and other unrelated controls are
  excluded from account selection.
- Jev and Laya use the same indexed control operations as the local ranker, with
  stale-control and response validation. Jev is timeout-bounded and explicit;
  Laya is optional. Playwright remains responsible for executing actions.
- Credential actions now reject targets outside the configured store or Shopify
  authentication origin, revalidate the live control and form target, block
  cross-origin navigation during the login attempt, and support the approved
  `shop.app` Sign in with Shop hop.
- Jev metadata is scrubbed before transmission: page context, email addresses,
  URL queries, and URL fragments are removed. Jev requests are bounded and
  Laya workers are closed after each login attempt.
- Store URLs must use HTTPS in both file-loaded and programmatic configuration.
- The bundled ranker model is resolved from the installed package, so the
  default engine also works through global and `npx` CLI installs.
- Programmatic configurations now enforce the same HTTPS store invariant as
  file-loaded configurations, and Jev href metadata drops complete query and
  fragment components before transmission.
- The bundled ranker model is resolved relative to the installed package rather
  than the caller's working directory, so the default engine also works through
  global and `npx` CLI installs.

### Added

- Store-level `decisionEngine` configuration with `local-ranker` as the default,
  plus explicit procedural, Jev, and Laya modes. The optional `auto` mode falls
  back from Laya to the local ranker; Jev requires explicit selection.
- Read-only discovery benchmark documentation covering ranker construction,
  comparison results, timing, and evaluation limits:
  [local ranker](docs/LOCAL-RANKER.md) and
  [discovery benchmark](docs/DISCOVERY-BENCHMARK.md).

### Benchmark

- On the 16-store comparison set, the fixed baseline, local ranker, Laya, and
  Jev each made 14/16 correct control selections.
- On a separate eight-store case-study cohort, the fixed baseline, local ranker,
  and Jev each made 6/8 selections; Laya made 5/8.
- Local selections generally completed in about 1-2 ms on the case-study cohort,
  compared with roughly 0.8-2.6 seconds for Jev and 3.4-10.4 seconds for Laya.
- These are read-only control-selection results, not complete login success
  rates. No credentials, code requests, clicks, fills, or submits were used.

## [0.2.0] - 2026-09-19

### Added

- `keycard init` creates a private `.env` session-encryption key and starter
  Testmail fields without an OpenSSL dependency or exposing the key in command
  output.
- A short end-to-end demo covers separate OTP sign-ins, encrypted session
  reuse, and portable Playwright storage state.

### Fixed

- The Shopify customer-accounts flow now follows a visible storefront account
  link when a theme does not use the `shopify-account` popover.
- The Shopify customer-accounts flow now submits a segmented OTP field with
  Enter when the storefront provides no visible submit button.
- The Shopify customer-accounts flow now uses keyboard events for segmented OTP
  inputs, matching the interaction expected by current Shopify account pages.


## [0.1.2] - 2026-09-18

### Fixed

- npm installation and one-off `npx` CLI instructions now use the published
  package name and `keycard` binary correctly.

## [0.1.1] - 2026-09-18

### Fixed

- Release workflow now uses current GitHub Actions runtimes and npm 11.19.1
  for the Linux package test and trusted publish.

## [0.1.0] - 2026-09-18

Initial public release.

### Added

- Shopify new-customer-account sessions for headless tests, verified on a
  Shopify development store.
- Experimental password-based classic-customer flow. It has not been verified
  on a live classic-accounts store.
- Testmail and human code providers, named and minted test shoppers, encrypted
  session storage, and a browser fallback ladder for human-completed challenges.
- Node API, CLI, Playwright fixture, and opt-in MCP server.

### Security

- Secrets are resolved from references rather than stored as literals.
- Session files are encrypted, scoped to the shopper and store, and written
  with restrictive permissions.
- Inbox codes are accepted only when their tag matches the requesting shopper.
- MCP access is deny-first; raw sessions and named shoppers require explicit
  opt-in.

### Packaging

- Dual ESM/CommonJS package with no runtime dependencies.
- Offline tests, package smoke tests, npm tarball size checks, and GitHub CI.

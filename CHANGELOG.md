# Changelog

All notable changes are documented here. This project follows
[semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

- The default decision engine is now the offline `local-ranker` trained
  account-component model. It ranks only domain-valid controls and waits when
  none are available; procedural, Jev, and Laya remain explicit optional modes.
- The shipped compact ranker model recorded zero false positives and zero false
  negatives in merchant-group holdouts (36 positive and 281 negative records).
  In a separate read-only 16-surface observation cohort, it selected an account
  entry or alternate authentication control on 12 surfaces; no credentials or
  browser actions were used.
- AI decision engines now discover the initial storefront account-entry control
  before narrowing observations to the active authentication form. Jev and
  Laya use compatible operation/target choices with stale-control and response
  validation; procedural selectors remain an explicit fallback.
- Initial discovery ignores unrelated storefront carousel controls, such as
  `Slide left` and `Slide right`, so they cannot displace account-entry actions.
- Laya-facing observations now include semantic control metadata and visible
  account links, while newsletter, product-option, cookie, and consent regions
  are excluded from initial discovery. Decision guidance prioritizes account
  and login controls over generic storefront actions.
- Decision actions now reject targets outside the configured store or Shopify
  authentication origin, filter post-credential clicks through the domain gate,
  avoid logging page-derived control descriptions, bound Jev requests, and close
  Laya workers after each login attempt.
- Store URLs must use HTTPS. Credential actions across both Shopify flows now
  revalidate the live control and effective form target, block cross-origin
  navigations for the full login attempt, allow the supported `shop.app` Sign
  in with Shop hop, and sanitize Jev control metadata before transmission.
- Programmatic configurations now enforce the same HTTPS store invariant as
  file-loaded configurations, and Jev href metadata drops complete query and
  fragment components before transmission.
- The bundled ranker model is resolved relative to the installed package rather
  than the caller's working directory, so the default engine also works through
  global and `npx` CLI installs.

### Added

- Store-level `decisionEngine` configuration with `local-ranker` as the default,
  plus explicit procedural, Jev, and Laya modes. The optional `auto` mode falls
  back from Laya to the local ranker; Jev requires explicit selection. Playwright remains the required
  browser executor; Jev and Laya only choose indexed actions.

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

# Changelog

All notable changes are documented here. This project follows
[semantic versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-19

### Added

- `keycard init` creates a private `.env` session-encryption key and starter
  Testmail fields without an OpenSSL dependency or exposing the key in command
  output.

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

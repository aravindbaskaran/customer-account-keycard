# Contributing

Thanks for contributing. Store and theme differences are useful input for this project.

## The most valuable contributions

1. **A store where a flow breaks.** Themes render the account popover differently; stores may use classic accounts, Sign in with Shop, or CAPTCHA. Include `KEYCARD_LOG=debug` output, the theme name, and the customer-account type. Do not include passwords, API keys, session files, or login codes.
2. **Verifying `shopify-classic-customer`.** It is written but untested, because the development store it was built against uses new customer accounts. If you have a classic-accounts store, running it and reporting what the selectors actually match would close a known gap. Its `selectors.ts` carries a `verifiedOn` marker that should stop saying "unverified".
3. **A new challenge provider.** `ChallengeProvider` is a two-method interface. An `imap` provider (any mailbox, with plus-addressing), Mailosaur, or a self-hosted relay would each let people use keycard without testmail.app. Put it in `src/providers/`, register it in `src/providers/index.ts`, and add the config shape to `src/core/config.ts`.
4. **Selector drift.** Each flow keeps selectors in one `selectors.ts` with a `verifiedOn` date.

## What will not be merged

- Anything that solves, bypasses, or fingerprint-spoofs a CAPTCHA. The `cdp` level exists so a human can complete a challenge in a real browser; that is the supported answer.
- Mocked or forged sessions, or anything that fabricates a customer identity rather than logging in for real. A session that Shopify would not have issued is worse than no session.
- Runtime dependencies, unless there is no reasonable alternative. keycard ships with zero on purpose: it installs into test suites, and a test tool should not drag a tree behind it. Node 22 built-ins and optional peer dependencies cover a lot.
- Credentials, tokens, store domains, or session files in commits or test fixtures.

## Ground rules for test accounts

Only run keycard against stores you own or are explicitly authorised to test. This is also testmail.app's rule: their terms prohibit using their mailboxes to create accounts on third-party services in a way that violates those services' terms, and require the service owner's permission before load-testing signups. Do not point keycard at a store you do not control, and do not use it to create accounts in bulk anywhere.

## Development

```bash
git clone https://github.com/aravindbaskaran/customer-account-keycard
cd customer-account-keycard
npm install
npm run build        # dist/, esm + cjs + types
npm test             # 49 offline unit tests
npm run typecheck
```

Unit tests must stay offline: stub `fetch`, use a temp directory for the session store, and never require a real store or API key. `test/unit/dual-format.test.ts` loads the built output in both module formats, so run `npm run build` before `npm test` if you changed the build.

### Live tests

```bash
KEYCARD_LIVE=1 KEYCARD_CONFIG=/path/to/your/keycard.json npm run test:live
```

These log in to a real store with a real emailed code, so they need your own `keycard.json`, a testmail.app key, and `KEYCARD_KEY`. Keep the shopper count low: each login consumes one email from your testmail quota and counts against Shopify's per-address code-send rate limit. CI must not run them by default.

## Pull requests

- One concern per pull request. A selector fix and a new provider are two pull requests.
- Add or update a test. If the change is about real-store behaviour that cannot be unit-tested, say in the description exactly what you ran and what the output was.
- Explain non-obvious decisions in the pull request or relevant documentation.
- Match the surrounding style. There is no linter ceremony; `npm run typecheck` and `npm test` are the gate.
- Add yourself to `CREDITS.md`.
- By contributing you agree your work is licensed under this project's MIT license.

## Releases

Maintainers only: [PUBLISHING.md](PUBLISHING.md). Every release updates `CHANGELOG.md` first, then `npm version`, then pushes the version tag to trigger the publish workflow. Contributors never need to publish anything.

## Reporting something sensitive

If you find a way for keycard to leak a session, a code, or a secret, do not open a public issue. See `SECURITY.md`.

# Repository rules

`customer-account-keycard` handles credentials that can authenticate a real
Shopify customer. Treat session state, one-time codes, inbox keys, storefront
passwords, store domains, customer email addresses, screenshots, traces, and
recordings as sensitive unless they are demonstrably synthetic.

## Before changing code

- Read `SECURITY.md`, the relevant flow's selector metadata, and the matching
  unit tests. Preserve the deny-first MCP policy and the rule that CAPTCHA is
  handed to a human rather than bypassed.
- Keep the public API compatible within the current semver range. Document any
  intentional API, configuration, or security-policy change in `CHANGELOG.md`.
- Do not add a runtime dependency without a concrete capability that Node or an
  optional peer cannot supply. Explain the dependency, its license, and its
  supply-chain impact in the pull request.

## Tests and fixtures

- Unit tests must be offline and must not launch a browser, contact an inbox,
  read a real config, or depend on a developer machine. Inject or mock the
  Playwright launch boundary before exercising flow logic.
- Live tests remain opt-in (`KEYCARD_LIVE=1`), use only authorised test stores
  and dedicated test shoppers, and must never run on pull requests by default.
- Do not put storage state, OTPs, credentials, personal data, or a real store
  identifier in fixtures, snapshots, logs, screenshots, test names, or docs.

## Required checks

Run `npm run verify` for a release or a meaningful change. It type-checks,
builds, runs unit tests, and validates the npm tarball's contents and size.
`npm run test:live` is a separate, authorised verification step; describe the
flow and result rather than committing its data.

## Agent skills

For release-readiness work, read `skills/open-source-release/SKILL.md`. Copies
are provided in `.agents/skills/` and `.codex/skills/` for project-local skill
discovery.

## Release and documentation

- A release may only start from a clean worktree with every intended source,
  policy, workflow, and test file tracked. Review `git status --short` and
  `git ls-files` before tagging.
- The README is the canonical user guide. Keep verification claims dated and
  scoped; label unverified flows as experimental. Do not copy internal project
  paths, merchant migration notes, or stale test counts into public docs.
- Follow `PUBLISHING.md`; use protected GitHub Actions trusted publishing and
  do not publish from a laptop except for the documented first-release fallback.

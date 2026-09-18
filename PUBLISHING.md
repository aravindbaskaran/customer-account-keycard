# Publishing to npm

Use a clean worktree. Do not publish a session, login code, store credential,
or local configuration.

## Before every release

1. Review `git status --short`; every intended source, policy, workflow, and
   test file must be tracked.
2. Update `CHANGELOG.md` and confirm the README's verification status is still
   accurate. Keep `shopify-classic-customer` marked experimental until it has
   an authorised live verification.
3. Run the release gate:

   ```bash
   npm ci
   npm run verify
   npm pack --dry-run
   ```

   Read the package file list. It should contain the built package, `config/`,
   `README.md`, `LICENSE`, and `package.json`. Repository policies and release
   notes stay on GitHub and are deliberately excluded by the `files` allowlist.
4. Ensure the repository, homepage, issue, and security links are correct.
   Enable GitHub private vulnerability reporting before the first release.

## First-time npm setup

Create an npm account and enable two-factor authentication. For the one-time
local bootstrap publish, authenticate with either `npm login` or a granular
write token. Then confirm the package name:

```bash
npm view customer-account-keycard
npx --yes --package=customer-account-keycard keycard --version
```

The last command confirms whether the unscoped name is available. If you use a
scoped package, publish it with `--access public` and update the package name,
installation instructions, and smoke test together.

## First public version

npm requires a package to exist before you can configure its trusted publisher.
Publish the first version manually with your npm account protected by two-factor
authentication:

```bash
npm publish
```

Then, on npmjs.com, open the package's **Settings** > **Trusted publishing** and
add GitHub Actions with these exact values:

| Field | Value |
| --- | --- |
| Owner | `aravindbaskaran` |
| Repository | `customer-account-keycard` |
| Workflow filename | `release.yml` |
| Environment | `npm-publish` |
| Allowed action | `npm publish` |

Tag and push that same release commit after the publisher is configured. The
workflow verifies it and sees the version is already on npm, so it does not try
to publish a duplicate.

```bash
git tag v0.1.0
git push origin main --follow-tags
```

## Later versions

The version in `package.json` and the git tag must match.

```bash
npm version 0.1.1 -m "Release v%s"
git push origin main --follow-tags
```

Pushing the version tag starts the GitHub Actions workflow, which publishes via
npm trusted publishing. It needs no npm token. You may re-run it manually with
that tag selected as the workflow ref. A GitHub Release is optional release
notes; it does not start npm publishing. Do not add an npm token to repository
secrets as a substitute.

## Verify the published package

```bash
npm view customer-account-keycard
```

Confirm the package page renders the README, the links resolve, and the
published package has the expected version. If a secret is ever published,
rotate it immediately; removal from the registry does not make it safe again.

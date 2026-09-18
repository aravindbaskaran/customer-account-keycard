---
name: open-source-release
description: Audit or prepare customer-account-keycard for a public release, especially its credential handling, npm artifact, docs, and CI. Use for release-readiness work, not ordinary feature development.
---

# Open-source release readiness

This package creates and handles real authenticated customer sessions. Optimise
for safe, reproducible releases over convenience.

1. Read `AGENTS.md`, `SECURITY.md`, `PUBLISHING.md`, and the changed public
   documentation. Confirm public examples use synthetic identifiers and that
   all compatibility claims are evidence-backed.
2. Check `CHANGELOG.md` for a concise, dated entry matching the release
   version. It should describe public changes and keep unverified flows marked
   experimental; omit internal postmortems and migration history.
3. Inspect both the worktree and Git history. A clean secret scan of the
   current files is insufficient if an exposed credential exists in a reachable
   commit. Stop before publishing if source, policies, tests, or workflows are
   untracked.
4. Run `npm run verify`, inspect `npm pack --dry-run --json`, and use the
   reported compressed size, unpacked size, and file list as the release
   baseline. The tarball must contain only the declared public artifact.
5. Treat a test that launches a browser, uses the network, or needs a local
   credential as an integration test, not a unit test. Keep such checks opt-in
   and document their authorisation and result without recording their data.
6. Retain deny-first defaults for MCP access, session export paths, and secret
   handling. Do not add CAPTCHA bypasses, session forging, or mechanisms that
   expose cookies, login codes, or secrets by default.

Report release blockers separately from improvements. Do not tag, publish, or
change external repository settings without explicit authorisation.

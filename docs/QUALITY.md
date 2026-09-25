---
layout: default
title: Quality
permalink: /docs/quality/
---

# Quality baseline

This document defines the measurable release gate for the public package. It
does not replace the security review in [SECURITY.md](https://github.com/aravindbaskaran/customer-account-keycard/blob/main/SECURITY.md).

## Automated gate

`npm run verify` must pass before a release. It runs:

1. TypeScript type checking.
2. The ESM/CJS build.
3. Offline unit tests.
4. `npm run quality`, which packages the project in dry-run mode and rejects a
  tarball above 100 KiB compressed or 288 KiB unpacked, unexpected files, and
   sensitive artifact paths.

The gate is also part of CI on supported Node versions. Dependency updates are
opened monthly through Dependabot; dependency audit failures at high severity
or above fail CI.

## Initial baseline (2026-09-18)

| Measure | Value |
| --- | ---: |
| TypeScript source and test lines | 2,602 |
| Offline unit tests declared | 49 |
| Runtime dependencies | 0 |
| npm package files | 26 |
| Compressed tarball | 54,365 bytes (53.1 KiB) |
| Unpacked tarball | 190,332 bytes (185.9 KiB) |
| Production `npm audit` vulnerabilities | 0 |

The size limits are guardrails, not a claim that smaller is always better. The
unpacked limit was raised to 288 KiB for the bundled local-ranker model, its
package-relative asset export, and security controls; the compressed limit
remains 100 KiB. Raise either limit
only when a review explains why the new shipped content is needed.

## Known release-quality gaps

- The classic-customer flow is intentionally experimental until it has an
  authorised live verification.
- Before a tag, add every intended file to Git and inspect the complete staged
  diff.

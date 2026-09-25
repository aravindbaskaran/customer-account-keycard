---
layout: default
title: Customer Account Keycard
description: Shopify customer-account discovery, session handling, and benchmarks.
permalink: /docs/
---

# Customer Account Keycard

Technical notes for the Shopify customer-account flows and their control
selection methods.

## Guides

- [Local ranker]({{ '/docs/local-ranker/' | relative_url }}): how the default offline selector was built,
  what it scores, and why it is the default.
- [Discovery benchmark]({{ '/docs/discovery-benchmark/' | relative_url }}): measured results against the
  fixed baseline, Laya, and Jev.
- [Setup]({{ '/docs/setup/' | relative_url }}): local installation and development setup.
- [Design]({{ '/docs/design/' | relative_url }}): flow and integration design notes.
- [Quality]({{ '/docs/quality/' | relative_url }}): verification and quality expectations.

## Scope

The benchmark pages describe control selection from visible page elements. They
do not claim that a complete customer login succeeds on every storefront.
Credential handling, session storage, navigation checks, and CAPTCHA hand-off
remain part of the main Keycard flow.
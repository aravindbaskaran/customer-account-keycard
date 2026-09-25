---
layout: default
title: Local ranker
description: How Keycard's default local control selector is built and used.
permalink: /docs/local-ranker/
---

# Local ranker

The local ranker is the default control-selection mode in Keycard. It helps
the flow choose among visible controls on a Shopify storefront when fixed
selectors do not identify the account surface reliably.

It is deliberately small and local. It does not authenticate customers, read
inbox messages, manage sessions, or replace the flow's credential and CAPTCHA
handling.

## How it was built

The training data came from Playwright observations of public storefront pages.
Each observed control was recorded with its tag, label, placeholder, type,
name, autocomplete value, link or form destination, and nearby form or section
context. Playwright-confirmed labels identified account controls, email fields,
one-time-code fields, and unrelated controls such as search, cart, newsletter,
rewards, and product controls.

The shipped model contains 309 labelled training records. It is a compressed,
inspectable linear model with a vocabulary, weights, and bias. It is not a
general-purpose language model and is not a fine-tuned Laya checkpoint.

## Runtime path

For each decision, Keycard:

1. Collects visible and enabled interactive controls from the active page or
   authentication form.
2. Removes controls from unrelated page areas and filters candidates for the
   current operation: click, email entry, or one-time-code entry.
3. Extracts words and account-flow indicators from the control metadata.
4. Scores the remaining candidates with the bundled model.
5. Selects the highest-scoring candidate, using document order as the
   deterministic tie-breaker.

The selected control still passes Keycard's trusted-origin, navigation, and
live browser-state checks before any action is taken. An empty or unsafe result
fails closed.

The implementation is in [`src/flows/decision.ts`](https://github.com/aravindbaskaran/customer-account-keycard/blob/main/src/flows/decision.ts).

## Why it is the default

In the recorded benchmark, the local ranker matched the remote engines on the
tested samples while avoiding network requests, API keys, service availability
issues, and remote inference latency. It also keeps observed page data inside
the running process.

Laya and Jev remain available when a project has an approved reason to use an
external engine. They are opt-in because they add configuration, network
calls, latency, and an external data boundary.
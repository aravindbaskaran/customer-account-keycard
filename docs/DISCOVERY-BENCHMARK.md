---
layout: default
title: Discovery benchmark
description: Measured comparison of Keycard's control-selection methods.
permalink: /docs/discovery-benchmark/
---

# Discovery benchmark

This benchmark compares the fixed baseline, the local ranker, Laya, and Jev on
visible Shopify storefront controls.

The benchmark records page controls with Playwright and asks each method to
choose an account control, email field, or one-time-code field. It does not
click, fill, submit, request codes, or use customer credentials. A successful
selection means that the chosen control matched the benchmark's expected label;
it does not mean that a complete login succeeded.

The local ranker was evaluated using 309 Playwright-confirmed training records.
The results below are from the 2026-09-25 discovery report.

## Results

### Primary comparison set

| Method | Correct selections |
|---|---:|
| Fixed baseline | 14/16 |
| Local ranker | 14/16 |
| Laya | 14/16 |
| Jev | 14/16 |

### Separate case-study cohort

| Method | Successful selections |
|---|---:|
| Fixed baseline | 6/8 |
| Local ranker | 6/8 |
| Laya | 5/8 |
| Jev | 6/8 |

The local ranker did not show higher selection accuracy in these samples. Its
advantage was that it produced comparable results locally, without API cost or
network inference.

## Selection time

On the separate case-study cohort, local-ranker selections generally completed
in about 1-2 ms. Jev selections took roughly 0.8-2.6 seconds, and Laya
selections took roughly 3.4-10.4 seconds. Remote timings include service and
model overhead; API cost for Jev was not measured.

These timings are indicative rather than guarantees. They depend on the page,
engine configuration, machine, network, and service load.

## Limits of the result

This is a control-selection benchmark, not an end-to-end authentication study.
The cohort is small, the labels are scoped to visible controls, and the
results do not establish success on every Shopify storefront. Live login
verification remains a separate, opt-in test requiring an authorized
development or test store and dedicated test shoppers.

The runtime implementation is in
[`src/flows/decision.ts`](https://github.com/aravindbaskaran/customer-account-keycard/blob/main/src/flows/decision.ts). The benchmark report is
generated from read-only Playwright observations and is not included in the
published npm package.
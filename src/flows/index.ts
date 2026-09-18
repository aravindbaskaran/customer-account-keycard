import type { Flow, FlowId } from "../core/types.js";
import { shopifyCustomerAccounts } from "./shopify-customer-accounts/index.js";
import { shopifyClassicCustomer } from "./shopify-classic-customer/index.js";
import { log } from "../core/logger.js";

const flows: Record<FlowId, Flow> = {
  "shopify-customer-accounts": shopifyCustomerAccounts,
  "shopify-classic-customer": shopifyClassicCustomer,
};

export function registerFlow(flow: Flow): void {
  flows[flow.id] = flow;
}

const EXPERIMENTAL: Partial<Record<FlowId, string>> = {
  "shopify-classic-customer": "shopify-classic-customer is EXPERIMENTAL and has never been run against a real classic-accounts store. Its selectors are guesses. Report what happens: it is the fastest way to get it verified.",
};

const warned = new Set<string>();

export function getFlow(id: FlowId): Flow {
  const f = flows[id];
  if (!f) throw new Error(`unknown flow ${id}`);
  const note = EXPERIMENTAL[id];
  if (note && !warned.has(id)) {
    warned.add(id);
    log.warn(note);
  }
  return f;
}

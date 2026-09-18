import { randomBytes } from "node:crypto";
import type { Shopper, StoreConfig } from "./types.js";

export function mintShopper(store: StoreConfig, namespace: string, role = "shopper", meta?: Record<string, string>): Shopper {
  const shortid = randomBytes(4).toString("hex");
  const safeRole = role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shopper";
  const tag = `${store.pool.prefix}-${safeRole}-${shortid}`;
  return {
    id: `${store.id}:mint:${safeRole}-${shortid}`,
    store: store.id,
    email: `${namespace}.${tag}@inbox.testmail.app`,
    role: safeRole,
    ephemeral: true,
    meta,
    challenges: [
      { kind: "email-code", provider: "testmail", options: { tag } },
      { kind: "human", provider: "human" },
    ],
  };
}

export function isMintedId(id: string): boolean {
  return id.includes(":mint:");
}

import { test as base } from "@playwright/test";
import { exportSession, getSession } from "../index.js";
import type { StorageState } from "../core/types.js";

export interface KeycardFixtures {
  shopperId: string;
}

export const test = base.extend<KeycardFixtures>({
  shopperId: ["", { option: true }],
  storageState: async ({ shopperId }, use) => {
    if (!shopperId) {
      await use(undefined);
      return;
    }
    const session = await getSession(shopperId);
    await use(session.storageState as StorageState as never);
  },
});

export const expect = base.expect;

export async function setupShoppers(ids: string[], outDir = ".auth"): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = await exportSession(id, `${outDir}/${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
  return out;
}

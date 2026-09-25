import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultChallenges } from "../../src/core/config.js";
import { mintShopper } from "../../src/core/pool.js";
import { Keycard } from "../../src/core/acquire.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "keycard-cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.TM_NS; delete process.env.STORE_URL; });

const cfg = {
  version: 1,
  providers: { testmail: { apiKey: "env:TM_KEY", namespace: "env:TM_NS" } },
  stores: [{ id: "demo", flow: "shopify-customer-accounts", storeUrl: "env:STORE_URL", shopId: 100, pool: { provider: "testmail", prefix: "demo" }, ttlHours: 2 }],
  shoppers: [{ id: "owner", store: "demo", email: "ns1.owner1@inbox.testmail.app", role: "owner" }],
};

describe("loadConfig", () => {
  it("loads JSON, resolves env refs, applies defaults and derives challenges", async () => {
    writeFileSync(join(dir, "keycard.json"), JSON.stringify(cfg));
    writeFileSync(join(dir, ".env"), "TM_KEY=k\nTM_NS=ns1\nSTORE_URL=https://demo.myshopify.com/\n");
    const c = await loadConfig(join(dir, "keycard.json"));
    expect(c.stores.demo.storeUrl).toBe("https://demo.myshopify.com");
    expect(c.stores.demo.shopId).toBe("100");
    expect(c.stores.demo.ttlHours).toBe(2);
    expect(c.stores.demo.cooldownSeconds).toBe(120);
    expect(c.stores.demo.ladder).toEqual(["headless", "headed", "cdp"]);
    expect(c.defaults.decisionEngine).toBe("local-ranker");
    expect(c.stores.demo.decisionEngine).toBe("local-ranker");
    expect(c.shoppers.owner.challenges[0]).toEqual({ kind: "email-code", provider: "testmail", options: { tag: "owner1" } });
    expect(c.shoppers.owner.challenges[1].provider).toBe("human");
  });
  it("accepts a store decision engine and rejects unknown values", async () => {
    writeFileSync(join(dir, "keycard.json"), JSON.stringify({ ...cfg, defaults: { decisionEngine: "laya" }, stores: [{ ...cfg.stores[0], decisionEngine: "procedural" }] }));
    writeFileSync(join(dir, ".env"), "TM_KEY=k\nTM_NS=ns1\nSTORE_URL=https://d\n");
    const c = await loadConfig(join(dir, "keycard.json"));
    expect(c.defaults.decisionEngine).toBe("laya");
    expect(c.stores.demo.decisionEngine).toBe("procedural");

    writeFileSync(join(dir, "keycard.json"), JSON.stringify({ ...cfg, stores: [{ ...cfg.stores[0], decisionEngine: "unknown" }] }));
    await expect(loadConfig(join(dir, "keycard.json"))).rejects.toThrow(/decisionEngine/);
  });
  it("rejects an unknown store reference", async () => {
    writeFileSync(join(dir, "keycard.json"), JSON.stringify({ ...cfg, shoppers: [{ id: "x", store: "nope", email: "a@b" }] }));
    writeFileSync(join(dir, ".env"), "TM_KEY=k\nTM_NS=ns1\nSTORE_URL=https://d\n");
    await expect(loadConfig(join(dir, "keycard.json"))).rejects.toThrow(/unknown store nope/);
  });
  it("rejects a non-HTTPS store URL", async () => {
    writeFileSync(join(dir, "keycard.json"), JSON.stringify({ ...cfg, stores: [{ ...cfg.stores[0], storeUrl: "http://demo.myshopify.com" }] }));
    writeFileSync(join(dir, ".env"), "TM_KEY=k\nTM_NS=ns1\nSTORE_URL=http://demo.myshopify.com\n");
    await expect(loadConfig(join(dir, "keycard.json"))).rejects.toThrow(/storeUrl.*HTTPS/);
  });
  it("rejects an unknown flow", async () => {
    writeFileSync(join(dir, "keycard.json"), JSON.stringify({ ...cfg, stores: [{ ...cfg.stores[0], flow: "magic" }] }));
    writeFileSync(join(dir, ".env"), "TM_KEY=k\nTM_NS=ns1\nSTORE_URL=https://d\n");
    await expect(loadConfig(join(dir, "keycard.json"))).rejects.toThrow(/unknown flow magic/);
  });
  it("rejects literal credentials in a config file", async () => {
    writeFileSync(join(dir, "keycard.json"), JSON.stringify({
      ...cfg,
      providers: { testmail: { ...cfg.providers.testmail, apiKey: "not-a-reference" } },
      stores: [{ ...cfg.stores[0], storefrontPassword: "cleartext" }],
    }));
    writeFileSync(join(dir, ".env"), "TM_NS=ns1\nSTORE_URL=https://d\n");
    await expect(loadConfig(join(dir, "keycard.json"))).rejects.toThrow(/apiKey.*env:.*op:\/\/.*file:/);
  });
});

describe("programmatic config defaults", () => {
  it("defaults omitted decision engines to local-ranker", () => {
    const keycard = new Keycard({
      version: 1,
      defaults: { ttlHours: 1, cooldownSeconds: 0, ladder: ["headless"], challengeTimeoutMs: 1000 },
      providers: {},
      stores: {
        demo: {
          id: "demo",
          flow: "shopify-customer-accounts",
          storeUrl: "https://demo.example",
          pool: { provider: "testmail", prefix: "demo" },
          ttlHours: 1,
          cooldownSeconds: 0,
          ladder: ["headless"],
        },
      },
      shoppers: {},
      configDir: dir,
    });

    expect(keycard.config.defaults.decisionEngine).toBe("local-ranker");
    expect(keycard.config.stores.demo.decisionEngine).toBe("local-ranker");
  });
});

describe("defaultChallenges", () => {
  it("strips the namespace prefix into the tag", () => {
    expect(defaultChallenges("ns.demo-owner@inbox.testmail.app", "ns")[0].options?.tag).toBe("demo-owner");
  });
});

describe("mintShopper", () => {
  it("mints unique addresses under the pool prefix with a matching tag", () => {
    const store = { id: "demo", flow: "shopify-customer-accounts" as const, storeUrl: "https://d", pool: { provider: "testmail" as const, prefix: "demo" }, ttlHours: 1, cooldownSeconds: 0, ladder: ["headless" as const], decisionEngine: "auto" as const };
    const a = mintShopper(store, "ns1", "Gifter");
    const b = mintShopper(store, "ns1", "Gifter");
    expect(a.email).not.toBe(b.email);
    expect(a.email).toMatch(/^ns1\.demo-gifter-[0-9a-f]{8}@inbox\.testmail\.app$/);
    expect(a.id).toMatch(/^demo:mint:gifter-[0-9a-f]{8}$/);
    expect(a.challenges[0].options?.tag).toBe(a.email.split("@")[0].slice(4));
    expect(a.ephemeral).toBe(true);
  });
});

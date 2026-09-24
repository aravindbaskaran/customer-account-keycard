import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrowserLevel, ChallengeBinding, DecisionEngine, FlowId, KeycardConfig, Shopper, StoreConfig } from "./types.js";
import { isSecretRef, resolveMaybeSecret } from "./secrets.js";

const LEVELS: BrowserLevel[] = ["headless", "headed", "cdp"];
const FLOWS: FlowId[] = ["shopify-customer-accounts", "shopify-classic-customer"];
const DECISION_ENGINES: DecisionEngine[] = ["local-ranker", "auto", "procedural", "jev", "laya"];

function fail(path: string, msg: string): never {
  throw new Error(`config ${path}: ${msg}`);
}

function str(obj: Record<string, unknown>, key: string, where: string, required = true): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) fail(where, `missing "${key}"`);
    return undefined;
  }
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") fail(where, `"${key}" must be a string`);
  return v;
}

function secretRef(obj: Record<string, unknown>, key: string, where: string, required = true): string | undefined {
  const value = str(obj, key, where, required);
  if (value !== undefined && !isSecretRef(value)) fail(where, `"${key}" must use an env:, op://, or file: reference`);
  return value;
}

function num(obj: Record<string, unknown>, key: string, where: string, fallback: number): number {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || Number.isNaN(v)) fail(where, `"${key}" must be a number`);
  return v;
}

function ladder(obj: Record<string, unknown>, where: string, fallback: BrowserLevel[]): BrowserLevel[] {
  const v = obj.ladder;
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => !LEVELS.includes(x))) fail(where, `"ladder" must be a non-empty list of ${LEVELS.join("|")}`);
  return v as BrowserLevel[];
}

function decisionEngine(obj: Record<string, unknown>, where: string, fallback: DecisionEngine): DecisionEngine {
  const value = obj.decisionEngine;
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !DECISION_ENGINES.includes(value as DecisionEngine)) {
    fail(where, `"decisionEngine" must be one of ${DECISION_ENGINES.join("|")}`);
  }
  return value as DecisionEngine;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(where, "must be an object");
  return v as Record<string, unknown>;
}

function list(v: unknown, where: string): Record<string, unknown>[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(where, "must be a list");
  return v.map((x, i) => obj(x, `${where}[${i}]`));
}

function bindings(v: unknown, where: string): ChallengeBinding[] | undefined {
  if (v === undefined) return undefined;
  return list(v, where).map((b, i) => {
    const w = `${where}[${i}]`;
    const kind = str(b, "kind", w)!;
    const provider = str(b, "provider", w)!;
    if (kind !== "email-code" && kind !== "human") fail(w, `unknown kind ${kind}`);
    if (provider !== "testmail" && provider !== "human") fail(w, `unknown provider ${provider}`);
    const o = b.options === undefined ? undefined : obj(b.options, `${w}.options`);
    return {
      kind,
      provider,
      options: o && {
        subjectPattern: str(o, "subjectPattern", w, false),
        codePattern: str(o, "codePattern", w, false),
        tag: str(o, "tag", w, false),
      },
    };
  });
}

export function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

export function defaultChallenges(email: string, namespace: string): ChallengeBinding[] {
  const local = email.split("@")[0];
  const tag = namespace && local.startsWith(`${namespace}.`) ? local.slice(namespace.length + 1) : local;
  return [
    { kind: "email-code", provider: "testmail", options: { tag } },
    { kind: "human", provider: "human" },
  ];
}

const CONFIG_NAMES = ["keycard.json", "keycard.yaml", "keycard.yml", "identities.json", "identities.yaml", "identities.yml"];

export function findConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.KEYCARD_CONFIG) return resolve(process.env.KEYCARD_CONFIG);
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const name of CONFIG_NAMES) {
      const p = resolve(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), "keycard.json");
}

async function parseConfigFile(path: string): Promise<Record<string, unknown>> {
  const text = readFileSync(path, "utf8");
  if (/\.ya?ml$/.test(path)) {
    let yaml: { parse(s: string): unknown };
    try {
      yaml = (await import("yaml")) as never;
    } catch {
      fail(path, "YAML config needs the optional `yaml` package (npm i -D yaml), or use keycard.json");
    }
    return obj(yaml.parse(text), path);
  }
  return obj(JSON.parse(text), path);
}

export async function loadConfig(explicitPath?: string): Promise<KeycardConfig> {
  const path = findConfigPath(explicitPath);
  if (!existsSync(path)) throw new Error(`config not found: ${path} (pass --config or set KEYCARD_CONFIG)`);
  const configDir = dirname(path);
  loadDotenv(resolve(process.cwd(), ".env"));
  loadDotenv(resolve(configDir, ".env"));

  const raw = await parseConfigFile(path);
  if (raw.version !== 1) fail(path, `"version" must be 1`);
  const d = raw.defaults === undefined ? {} : obj(raw.defaults, `${path}#defaults`);
  const defaults = {
    ttlHours: num(d, "ttlHours", "defaults", 168),
    cooldownSeconds: num(d, "cooldownSeconds", "defaults", 120),
    ladder: ladder(d, "defaults", ["headless", "headed", "cdp"]),
    challengeTimeoutMs: num(d, "challengeTimeoutMs", "defaults", 90_000),
    decisionEngine: decisionEngine(d, "defaults", "local-ranker"),
  };

  const pr = raw.providers === undefined ? {} : obj(raw.providers, `${path}#providers`);
  const providers: KeycardConfig["providers"] = {};
  if (pr.testmail !== undefined) {
    const t = obj(pr.testmail, "providers.testmail");
    providers.testmail = { apiKey: secretRef(t, "apiKey", "providers.testmail")!, namespace: str(t, "namespace", "providers.testmail")! };
  }
  if (pr.human !== undefined) providers.human = { channel: "tty" };
  const namespace = providers.testmail ? (await resolveMaybeSecret(providers.testmail.namespace, { redact: false })) ?? "" : "";

  const stores: Record<string, StoreConfig> = {};
  for (const s of list(raw.stores, `${path}#stores`)) {
    const id = str(s, "id", "stores")!;
    const w = `stores.${id}`;
    const flow = str(s, "flow", w)!;
    if (!FLOWS.includes(flow as FlowId)) fail(w, `unknown flow ${flow}; known: ${FLOWS.join(", ")}`);
    const pool = obj(s.pool, `${w}.pool`);
    if (str(pool, "provider", `${w}.pool`) !== "testmail") fail(`${w}.pool`, "only the testmail pool provider exists");
    const storeUrl = (await resolveMaybeSecret(str(s, "storeUrl", w)!, { redact: false }))!.replace(/\/$/, "");
    let parsedStoreUrl: URL;
    try {
      parsedStoreUrl = new URL(storeUrl);
    } catch {
      fail(w, "storeUrl must be an absolute HTTPS URL");
    }
    if (parsedStoreUrl.protocol !== "https:") fail(w, "storeUrl must use HTTPS");
    stores[id] = {
      id,
      flow: flow as FlowId,
      storeUrl,
      shopId: str(s, "shopId", w, false),
      storefrontPassword: secretRef(s, "storefrontPassword", w, false),
      pool: { provider: "testmail", prefix: str(pool, "prefix", `${w}.pool`)! },
      ttlHours: num(s, "ttlHours", w, defaults.ttlHours),
      cooldownSeconds: num(s, "cooldownSeconds", w, defaults.cooldownSeconds),
      ladder: ladder(s, w, defaults.ladder),
      decisionEngine: decisionEngine(s, w, defaults.decisionEngine),
    };
  }

  const shoppers: Record<string, Shopper> = {};
  for (const sh of list(raw.shoppers, `${path}#shoppers`)) {
    const id = str(sh, "id", "shoppers")!;
    const w = `shoppers.${id}`;
    const store = str(sh, "store", w)!;
    if (!stores[store]) fail(w, `references unknown store ${store}`);
    const email = str(sh, "email", w)!;
    if (!email.includes("@")) fail(w, `"email" is not an address`);
    const meta = sh.meta === undefined ? {} : Object.fromEntries(Object.entries(obj(sh.meta, `${w}.meta`)).map(([k, v]) => [k, String(v)]));
    if (sh.smoke === true) meta.smoke = "true";
    shoppers[id] = {
      id,
      store,
      email,
      role: str(sh, "role", w, false),
      password: secretRef(sh, "password", w, false),
      ephemeral: false,
      meta,
      challenges: bindings(sh.challenges, `${w}.challenges`) ?? defaultChallenges(email, namespace),
    };
  }

  return { version: 1, defaults, providers, stores, shoppers, configDir };
}

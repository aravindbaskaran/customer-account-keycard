#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { exportSession, getOtp, keycard, mint, purgeEphemeral } from "./index.js";
import { findConfigPath } from "./core/config.js";
import { sessionDir } from "./core/session-store.js";
import { log } from "./core/logger.js";
import { loadPlaywright, playwrightSource } from "./core/pw.js";
import type { BrowserLevel } from "./core/types.js";
import { VERSION } from "./version.js";
import { initializeEnvKey } from "./core/init.js";

const version = VERSION;

const HELP = `keycard ${version}: real, cached Shopify customer-account sessions for headless tests

usage: keycard <command> [options]

  capture   --identity <id> [--level headless|headed|cdp] [--force] [--strict]
                                                                       log in (or reuse) and save the session
  validate  --identity <id> [--strict]                                 probe the saved session, print status
  export    --identity <id> --out <path> [--force]                     write plain Playwright storageState JSON
  mint      [--store <id>] [--role <role>]                             mint a fresh ephemeral shopper (prints id + email)
  otp       --identity <id> [--since <ms-epoch>]                       wait for and print the next login code
  list      [--ephemeral]                                              list shoppers and saved sessions
  clear     [--identity <id>] [--ephemeral] [--orphans]               delete saved sessions
  refresh   [--expiring-within <hours>]                                re-capture named sessions about to expire
  doctor                                                               check key, config, providers, browser
  init      [--env-output <path>]                                      create KEYCARD_KEY in .env, without printing it
  install-browser                                                      download Chromium for playwright-core
  mcp                                                                  run the MCP server on stdio

global: --config <path> (default: keycard.json / identities.yaml found upward from cwd), --json, --help
env:    KEYCARD_KEY (required), KEYCARD_CONFIG, KEYCARD_SESSION_DIR, KEYCARD_ALLOW_HUMAN=1, KEYCARD_CDP_URL,
        KEYCARD_LOG=debug|silent, KEYCARD_NO_CACHE=1, KEYCARD_REQUIRE_CONFIRMED_SESSION=1, KEYCARD_ARTIFACTS=1
`;

function out(json: boolean, data: unknown, text: () => string) {
  process.stdout.write(json ? JSON.stringify(data, null, 2) + "\n" : text() + "\n");
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      identity: { type: "string", short: "i" },
      store: { type: "string" },
      role: { type: "string" },
      level: { type: "string" },
      out: { type: "string", short: "o" },
      since: { type: "string" },
      force: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      ephemeral: { type: "boolean", default: false },
      orphans: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      "expiring-within": { type: "string" },
      "env-output": { type: "string" },
    },
  });
  const cmd = positionals[0];
  if (values.version) return process.stdout.write(version + "\n");
  if (values.help || !cmd) return process.stdout.write(HELP);
  const json = values.json!;
  const init = { config: values.config };
  const need = (name: "identity" | "out"): string => {
    const v = values[name];
    if (!v) throw new Error(`--${name} is required for ${cmd}`);
    return v;
  };

  switch (cmd) {
    case "init": {
      const result = await initializeEnvKey(values["env-output"]);
      return out(json, { ...result, keycardKey: "created" }, () => `created KEYCARD_KEY in ${result.envFile}; ${result.gitignoreUpdated ? "added .env to .gitignore; " : ""}do not commit it`);
    }
    case "capture": {
      const kc = await keycard(init);
      const s = await kc.getSession(need("identity"), { force: values.force, level: values.level as BrowserLevel | undefined, requireConfirmed: values.strict || undefined });
      return out(json, { shopperId: s.shopperId, email: s.email, expiresAt: s.expiresAt, browserLevel: s.browserLevel }, () => `${s.shopperId} (${s.email}) session valid until ${s.expiresAt}`);
    }
    case "validate": {
      const kc = await keycard(init);
      const id = need("identity");
      const shopper = await kc.resolveShopper(id);
      const s = await kc.store.load(kc.keyFor(shopper), { shopperId: shopper.id, email: shopper.email, store: shopper.store });
      if (!s) return out(json, { shopperId: id, status: "missing" }, () => `${id}: no saved session`);
      const verdict = await kc.validity(s);
      const strict = values.strict || kc.requireConfirmed();
      if (verdict === "invalid" || (strict && verdict !== "valid")) process.exitCode = 1;
      const label = verdict === "valid" ? "valid" : verdict === "invalid" ? "INVALID" : "UNCONFIRMED (the store did not give a usable answer; the session was kept)";
      return out(json, { shopperId: id, status: verdict, expiresAt: s.expiresAt, createdAt: s.createdAt }, () => `${id}: ${label} (created ${s.createdAt}, expires ${s.expiresAt})`);
    }
    case "export": {
      const p = await exportSession(need("identity"), need("out"), { ...init, force: values.force });
      return out(json, { path: p }, () => p);
    }
    case "mint": {
      const s = await mint(values.role ?? "shopper", { ...init, store: values.store });
      return out(json, s, () => `${s.id}\n${s.email}`);
    }
    case "otp": {
      const since = values.since ? Number(values.since) : Date.now() - 120_000;
      const code = await getOtp(need("identity"), since, init);
      return out(json, { code }, () => code);
    }
    case "list": {
      const kc = await keycard(init);
      const saved = new Map((await kc.store.list()).map((row) => [row.key, row.modifiedAt]));
      const row = (s: { id: string; store: string; email: string; role?: string }, ephemeral: boolean) => ({
        id: s.id, store: s.store, email: s.email, role: s.role, ephemeral,
        savedAt: saved.get(kc.keyFor({ ...s, ephemeral, challenges: [] })) ?? null,
      });
      const named = Object.values(kc.config.shoppers).map((s) => row(s, false));
      const minted = (await kc.store.listMinted()).map((s) => row(s, true));
      const known = new Set([...named, ...minted].map((r) => kc.keyFor({ id: r.id, store: r.store, email: r.email, ephemeral: r.ephemeral, challenges: [] })));
      const orphans = (await kc.store.list()).filter((row) => !known.has(row.key)).map((row) => ({ key: row.key, shopperId: row.session?.shopperId ?? "(unreadable)", savedAt: row.modifiedAt }));
      const rows = values.ephemeral ? minted : [...named, ...minted];
      return out(json, { shoppers: rows, orphans }, () => {
        const main = rows.map((r) => `${r.ephemeral ? "~" : " "} ${r.id}\t${r.email}\t${r.role ?? ""}\t${r.savedAt ? "saved " + r.savedAt.toISOString() : "no session"}`).join("\n") || "(none)";
        const extra = orphans.length ? `\n\n${orphans.length} saved session(s) match no current shopper (a renamed shopper, another project, or an older keycard). Remove them with: keycard clear --orphans\n` + orphans.map((o) => `  ? ${o.key}\t${o.shopperId}\t${o.savedAt.toISOString()}`).join("\n") : "";
        return main + extra;
      });
    }
    case "clear": {
      const kc = await keycard(init);
      if (values.ephemeral) {
        const ids = await purgeEphemeral({ ...init, all: true });
        return out(json, { removed: ids }, () => `removed ${ids.length} ephemeral session(s)`);
      }
      if (values.orphans) {
        const known = new Set<string>();
        for (const sh of Object.values(kc.config.shoppers)) known.add(kc.keyFor(sh));
        for (const sh of await kc.store.listMinted()) known.add(kc.keyFor(sh));
        const removed: string[] = [];
        for (const row of await kc.store.list()) {
          if (known.has(row.key)) continue;
          await kc.store.remove(row.key);
          removed.push(row.key);
        }
        return out(json, { removed }, () => `removed ${removed.length} orphaned session file(s)`);
      }
      const id = need("identity");
      const shopper = await kc.resolveShopper(id);
      await kc.store.remove(kc.keyFor(shopper));
      await kc.store.forgetMinted(id);
      return out(json, { removed: [id] }, () => `removed ${id}`);
    }
    case "refresh": {
      const kc = await keycard(init);
      const raw = String(values["expiring-within"] ?? "24h").trim();
      const hours = /^\d+(\.\d+)?h?$/i.test(raw) ? Number(raw.replace(/h$/i, "")) : NaN;
      if (!Number.isFinite(hours)) throw new Error(`--expiring-within expects hours like 24 or 24h, got "${raw}"`);
      const results: Array<{ id: string; action: string }> = [];
      for (const sh of Object.values(kc.config.shoppers)) {
        const s = await kc.store.load(kc.keyFor(sh), { shopperId: sh.id, email: sh.email, store: sh.store });
        const expiring = !s || new Date(s.expiresAt).getTime() - Date.now() < hours * 3_600_000 || (await kc.validity(s)) === "invalid";
        if (!expiring) { results.push({ id: sh.id, action: "kept" }); continue; }
        try {
          await kc.getSession(sh, { force: true });
          results.push({ id: sh.id, action: "captured" });
        } catch (err) {
          results.push({ id: sh.id, action: `failed: ${(err as Error).message}` });
          process.exitCode = 1;
        }
      }
      return out(json, results, () => results.map((r) => `${r.id}: ${r.action}`).join("\n"));
    }
    case "doctor": {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      const cfgPath = findConfigPath(values.config);
      checks.push({ name: "config", ok: existsSync(cfgPath), detail: cfgPath });
      let kc: Awaited<ReturnType<typeof keycard>> | null = null;
      try { kc = await keycard(init); checks.push({ name: "config parse", ok: true, detail: `${Object.keys(kc.config.stores).length} store(s), ${Object.keys(kc.config.shoppers).length} named shopper(s)` }); }
      catch (err) { checks.push({ name: "config parse", ok: false, detail: (err as Error).message }); }
      const key = process.env.KEYCARD_KEY;
      checks.push({ name: "KEYCARD_KEY", ok: !!key && Buffer.from(key, "base64").length === 32, detail: key ? "set" : "missing (run: keycard init)" });
      checks.push({ name: "session dir", ok: true, detail: sessionDir() });
      if (kc?.config.providers.testmail) {
        try {
          const { buildProviders } = await import("./providers/index.js");
          await buildProviders(kc.config);
          checks.push({ name: "testmail", ok: true, detail: "apiKey and namespace resolved" });
        } catch (err) { checks.push({ name: "testmail", ok: false, detail: (err as Error).message }); }
      }
      try {
        const { chromium } = await loadPlaywright();
        const b = await chromium.launch({ headless: true });
        checks.push({ name: "chromium", ok: true, detail: `launched ${b.version()} via ${playwrightSource()}` });
        await b.close();
      } catch (err) { checks.push({ name: "chromium", ok: false, detail: `${(err as Error).message.split("\n")[0]} (run: keycard install-browser)` }); }
      const bad = checks.filter((c) => !c.ok);
      if (bad.length) process.exitCode = 1;
      return out(json, checks, () => checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`).join("\n"));
    }
    case "install-browser": {
      execFileSync("npx", ["playwright", "install", "chromium"], { stdio: "inherit" });
      return;
    }
    case "mcp": {
      if (values.config) process.env.KEYCARD_CONFIG = resolvePath(values.config);
      const { startMcpServer } = await import("./mcp/server.js");
      return startMcpServer();
    }
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  log.warn((err as Error).message);
  process.exitCode = process.exitCode || 1;
});

import { resolve, relative, isAbsolute } from "node:path";
import { exportSession, getOtp, getSession, keycard, mint } from "../index.js";
import { isMintedId } from "../core/pool.js";
import { VERSION } from "../version.js";
import type { Shopper } from "../core/types.js";

export class McpPolicyError extends Error {}

export function allowedShopper(id: string): boolean {
  if (isMintedId(id)) return true;
  if (process.env.KEYCARD_MCP_ALLOW_NAMED === "1") return true;
  const list = (process.env.KEYCARD_MCP_SHOPPERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(id);
}

export function assertShopperAllowed(id: string): void {
  if (allowedShopper(id)) return;
  throw new McpPolicyError(
    `policy: "${id}" is a named shopper, and this MCP server only exposes minted shoppers by default. ` +
      `Add it to KEYCARD_MCP_SHOPPERS (comma separated), or set KEYCARD_MCP_ALLOW_NAMED=1, to allow it.`,
  );
}

export function exportRoot(): string {
  return resolve(process.env.KEYCARD_MCP_EXPORT_ROOT ?? resolve(process.cwd(), ".auth"));
}

export function resolveExportPath(out: string): string {
  const root = exportRoot();
  const target = isAbsolute(out) ? resolve(out) : resolve(root, out);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new McpPolicyError(`policy: refusing to write outside the export root ${root}. Set KEYCARD_MCP_EXPORT_ROOT to change it.`);
  }
  if (!/\.json$/.test(target)) throw new McpPolicyError("policy: export path must end in .json");
  return target;
}

function sessionSummary(s: Awaited<ReturnType<typeof getSession>>) {
  return {
    shopperId: s.shopperId,
    email: s.email,
    store: s.store,
    expiresAt: s.expiresAt,
    browserLevel: s.browserLevel,
    cookieCount: s.storageState.cookies.length,
    origins: s.storageState.origins.map((o) => o.origin),
    note: "Storage state withheld. It is a live credential. Use export_session and point Playwright at the file, or set KEYCARD_MCP_ALLOW_RAW_SESSION=1 if you truly need the cookies inline.",
  };
}

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run(args: Record<string, unknown>): Promise<unknown> };

const tools: Tool[] = [
  {
    name: "list_shoppers",
    description: "List configured stores and shoppers. Shows which shoppers this server is allowed to act on.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const kc = await keycard();
      const decorate = (s: Shopper | { id: string; store: string; email: string; role?: string }) => ({ id: s.id, store: s.store, email: s.email, role: s.role, allowed: allowedShopper(s.id) });
      return {
        stores: Object.values(kc.config.stores).map((s) => ({ id: s.id, flow: s.flow, storeUrl: s.storeUrl })),
        shoppers: Object.values(kc.config.shoppers).map(decorate),
        minted: (await kc.store.listMinted()).map(decorate),
        policy: {
          namedShoppersAllowed: process.env.KEYCARD_MCP_ALLOW_NAMED === "1" ? "all" : (process.env.KEYCARD_MCP_SHOPPERS ?? "(none)"),
          rawSessionAllowed: process.env.KEYCARD_MCP_ALLOW_RAW_SESSION === "1",
          exportRoot: exportRoot(),
        },
      };
    },
  },
  {
    name: "mint_shopper",
    description: "Mint a fresh ephemeral shopper address for a store. Nothing is created on Shopify until the first login.",
    inputSchema: { type: "object", properties: { store: { type: "string" }, role: { type: "string" } }, required: ["store"] },
    async run(a) { return mint(String(a.role ?? "shopper"), { store: String(a.store) }); },
  },
  {
    name: "get_session",
    description: "Log in if needed and return session metadata (expiry, cookie count, origins). The storage state itself is withheld unless the server is configured to reveal it; use export_session for Playwright.",
    inputSchema: { type: "object", properties: { shopper: { type: "string" }, force: { type: "boolean" } }, required: ["shopper"] },
    async run(a) {
      const id = String(a.shopper);
      assertShopperAllowed(id);
      const s = await getSession(id, { force: Boolean(a.force) });
      if (process.env.KEYCARD_MCP_ALLOW_RAW_SESSION === "1") return { ...sessionSummary(s), storageState: s.storageState, note: undefined };
      return sessionSummary(s);
    },
  },
  {
    name: "export_session",
    description: "Write a shopper's storageState JSON inside the export root, for `playwright --storage-state` or `test.use({ storageState })`. Returns the path.",
    inputSchema: { type: "object", properties: { shopper: { type: "string" }, out: { type: "string", description: "Path relative to the export root, ending in .json" } }, required: ["shopper", "out"] },
    async run(a) {
      const id = String(a.shopper);
      assertShopperAllowed(id);
      const target = resolveExportPath(String(a.out));
      return { path: await exportSession(id, target), warning: "This file is an unencrypted live session. Delete it when the run ends and never attach it to a bug report." };
    },
  },
  {
    name: "get_otp",
    description: "Wait for and return the latest login code emailed to a shopper after `since` (ms epoch). Call it after submitting the email on the login page.",
    inputSchema: { type: "object", properties: { shopper: { type: "string" }, since: { type: "number" } }, required: ["shopper", "since"] },
    async run(a) {
      const id = String(a.shopper);
      assertShopperAllowed(id);
      const since = Number(a.since);
      if (!Number.isFinite(since) || since <= 0) throw new McpPolicyError("`since` must be a millisecond epoch timestamp taken just before the login was submitted");
      return { code: await getOtp(id, since) };
    },
  },
];

export async function startMcpServer(): Promise<void> {
  let sdk: { Server: new (info: unknown, opts: unknown) => { setRequestHandler(schema: unknown, fn: (req: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<unknown>): void; connect(t: unknown): Promise<void> } };
  let types: { CallToolRequestSchema: unknown; ListToolsRequestSchema: unknown };
  let stdio: { StdioServerTransport: new () => unknown };
  try {
    sdk = (await import("@modelcontextprotocol/sdk/server/index.js")) as never;
    types = (await import("@modelcontextprotocol/sdk/types.js")) as never;
    stdio = (await import("@modelcontextprotocol/sdk/server/stdio.js")) as never;
  } catch {
    throw new Error("keycard mcp needs the optional @modelcontextprotocol/sdk package (npm i -D @modelcontextprotocol/sdk)");
  }
  const server = new sdk.Server({ name: "keycard", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  server.setRequestHandler(types.CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
    try {
      const result = await tool.run(req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  });
  await server.connect(new stdio.StdioServerTransport());
}

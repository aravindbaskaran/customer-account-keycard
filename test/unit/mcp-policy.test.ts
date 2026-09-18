import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedShopper, assertShopperAllowed, exportRoot, resolveExportPath, McpPolicyError } from "../../src/mcp/server.js";

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.KEYCARD_MCP_ALLOW_NAMED;
  delete process.env.KEYCARD_MCP_SHOPPERS;
  delete process.env.KEYCARD_MCP_EXPORT_ROOT;
});
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

describe("MCP shopper policy", () => {
  it("allows minted shoppers and refuses named ones by default", () => {
    expect(allowedShopper("demo:mint:gifter-abc12345")).toBe(true);
    expect(allowedShopper("demo-owner")).toBe(false);
    expect(() => assertShopperAllowed("demo-owner")).toThrow(McpPolicyError);
    expect(() => assertShopperAllowed("demo-owner")).toThrow(/KEYCARD_MCP_SHOPPERS/);
  });
  it("honours an explicit allowlist", () => {
    process.env.KEYCARD_MCP_SHOPPERS = "demo-owner, other";
    expect(allowedShopper("demo-owner")).toBe(true);
    expect(allowedShopper("not-listed")).toBe(false);
  });
  it("honours the allow-all switch", () => {
    process.env.KEYCARD_MCP_ALLOW_NAMED = "1";
    expect(allowedShopper("anything")).toBe(true);
  });
});

describe("MCP export path policy", () => {
  it("keeps writes inside the export root", () => {
    process.env.KEYCARD_MCP_EXPORT_ROOT = join(tmpdir(), "keycard-export-root");
    const root = exportRoot();
    expect(resolveExportPath("owner.json")).toBe(join(root, "owner.json"));
    expect(resolveExportPath("nested/owner.json")).toBe(join(root, "nested/owner.json"));
  });
  it("refuses traversal, absolute escapes, the root itself and non-json paths", () => {
    process.env.KEYCARD_MCP_EXPORT_ROOT = join(tmpdir(), "keycard-export-root");
    for (const bad of ["../escape.json", "../../etc/hosts.json", "/etc/hosts.json", "/tmp/elsewhere.json", "", "owner.txt", "nested/../../up.json"]) {
      expect(() => resolveExportPath(bad), bad).toThrow(McpPolicyError);
    }
  });
});

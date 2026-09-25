import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts", "playwright/index": "src/playwright/index.ts", "mcp/server": "src/mcp/server.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  shims: true,
  splitting: true,
  sourcemap: false,
  target: "node22",
  define: { __KEYCARD_VERSION__: JSON.stringify(pkg.version) },
  external: ["playwright", "playwright-core", "@playwright/test", "yaml", "@modelcontextprotocol/sdk"],
});

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const EXPECTED = ["getSession", "exportSession", "getOtp", "mint", "withShopper", "withShoppers", "toCookieHeader", "purgeEphemeral", "keycard"];

describe.skipIf(!existsSync(dist))("built output loads in both module formats", () => {
  const run = (code: string) => execFileSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8" }).trim();

  it("require() gives the public API", () => {
    const out = run(`const k = require("${dist}/index.cjs"); console.log(Object.keys(k).join(","))`);
    for (const name of EXPECTED) expect(out.split(",")).toContain(name);
  });

  it("import() gives the public API", () => {
    const out = run(`import("${dist}/index.js").then((k) => console.log(Object.keys(k).join(",")))`);
    for (const name of EXPECTED) expect(out.split(",")).toContain(name);
  });

  it("the CLI runs", () => {
    expect(run(`require("node:child_process").execFileSync(process.execPath, ["${dist}/cli.js", "--version"], { stdio: "inherit" })`)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

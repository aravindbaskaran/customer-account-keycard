import { describe, it, expect } from "vitest";
import { toCookieHeader } from "../../src/index.js";

describe("toCookieHeader", () => {
  it("filters by domain, path, secure and expiry", () => {
    const state = {
      cookies: [
        { name: "a", value: "1", domain: ".myshopify.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" as const },
        { name: "b", value: "2", domain: "dev.myshopify.com", path: "/account", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" as const },
        { name: "c", value: "3", domain: "shopify.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" as const },
        { name: "d", value: "4", domain: "dev.myshopify.com", path: "/", expires: 1, httpOnly: false, secure: false, sameSite: "Lax" as const },
      ],
      origins: [],
    };
    expect(toCookieHeader(state, "https://dev.myshopify.com/account")).toBe("a=1; b=2");
    expect(toCookieHeader(state, "https://dev.myshopify.com/")).toBe("a=1");
  });
});

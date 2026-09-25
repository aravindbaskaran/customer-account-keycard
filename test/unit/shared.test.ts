import { describe, expect, it, vi } from "vitest";
import { clearPasswordGate } from "../../src/flows/shared.js";

describe("clearPasswordGate", () => {
  it("waits for the password redirect while submitting", async () => {
    const box = {
      isVisible: vi.fn().mockResolvedValue(true),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };
    const submit = { evaluate: vi.fn().mockResolvedValue(undefined) };
    const form = {
      locator: vi.fn((selector: string) => ({
        first: () => selector.includes("password") ? box : submit,
      })),
    };
    const page = {
      url: () => "https://demo.myshopify.com/password",
      locator: vi.fn(() => ({
        filter: () => ({ first: () => form }),
      })),
      waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => {
        expect(predicate(new URL("https://demo.myshopify.com/password"))).toBe(false);
        expect(predicate(new URL("https://demo.myshopify.com/"))).toBe(true);
      }),
    };
    const ctx = {
      page,
      store: { storefrontPassword: "env:STOREFRONT_PASSWORD", storeUrl: "https://demo.myshopify.com" },
      secret: vi.fn().mockResolvedValue("synthetic-password"),
    } as never;

    await clearPasswordGate(ctx);

    expect(page.waitForURL).toHaveBeenCalledOnce();
    expect(submit.evaluate).toHaveBeenCalledOnce();
  });
});
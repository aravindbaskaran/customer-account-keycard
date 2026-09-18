import { describe, it, expect } from "vitest";
import { parseCode, testmailProvider } from "../../src/providers/testmail.js";
import type { Shopper } from "../../src/core/types.js";

const subject = /is your code/i;
const code = /\d{6}/;
const shopper: Shopper = { id: "s", store: "st", email: "ns.tag@inbox.testmail.app", ephemeral: false, challenges: [] };

describe("testmail parseCode", () => {
  it("refuses a code from another shopper's tag", () => {
    expect(parseCode({ subject: "123456 is your code", tag: "someone-else" }, subject, code, "mine")).toBeNull();
    expect(parseCode({ subject: "123456 is your code", tag: "mine" }, subject, code, "mine")).toBe("123456");
  });

  it("reads the code from the subject", () => {
    expect(parseCode({ subject: "123456 is your code" }, subject, code)).toBe("123456");
  });
  it("fails closed when a tag is required but the email carries none", () => {
    expect(parseCode({ subject: "123456 is your code" }, subject, code, "mine")).toBeNull();
  });
  it("ignores unrelated mail", () => {
    expect(parseCode({ subject: "Your order is confirmed", text: "order 987654" }, subject, code)).toBeNull();
  });
  it("falls back to the body", () => {
    expect(parseCode({ subject: "Here is your code", text: "Enter 654321 to continue" }, subject, code)).toBe("654321");
  });
});

describe("testmail provider", () => {
  it("ignores an email carrying a different tag even if the API returns it", async () => {
    const realFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      const emails = n === 1
        ? [{ subject: "999999 is your code", tag: "other-shopper" }]
        : [{ subject: "999999 is your code", tag: "other-shopper" }, { subject: "111222 is your code", tag: "tag" }];
      return new Response(JSON.stringify({ result: "success", emails }));
    }) as typeof fetch;
    try {
      const p = testmailProvider({ apiKey: "k", namespace: "ns", pollMs: 5 });
      const got = await p.answer({ shopper, since: 0, hint: "", timeoutMs: 2000 }, { kind: "email-code", provider: "testmail", options: { tag: "tag" } });
      expect(got).toBe("111222");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("polls until a matching email arrives and passes since/tag", async () => {
    const calls: URL[] = [];
    let n = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      calls.push(new URL(String(input)));
      n++;
      const emails = n < 2 ? [] : [{ subject: "111222 is your code", timestamp: 5, tag: "tag" }];
      return new Response(JSON.stringify({ result: "success", emails }));
    }) as typeof fetch;
    try {
      const p = testmailProvider({ apiKey: "k", namespace: "ns", pollMs: 5 });
      const got = await p.answer({ shopper, since: 42, hint: "", timeoutMs: 2000 }, { kind: "email-code", provider: "testmail", options: { tag: "tag" } });
      expect(got).toBe("111222");
      expect(calls.length).toBe(2);
      expect(calls[0].searchParams.get("tag")).toBe("tag");
      expect(calls[0].searchParams.get("pretag")).toBeNull();
      expect(calls[0].searchParams.get("timestamp_from")).toBe("42");
      expect(calls[0].searchParams.get("livequery")).toBe("false");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("times out with a clear error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: "success", emails: [] }))) as typeof fetch;
    try {
      const p = testmailProvider({ apiKey: "k", namespace: "ns", pollMs: 5 });
      await expect(p.answer({ shopper, since: 0, hint: "", timeoutMs: 30 }, { kind: "email-code", provider: "testmail", options: { tag: "t" } })).rejects.toThrow(/no code for ns.tag@inbox.testmail.app/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

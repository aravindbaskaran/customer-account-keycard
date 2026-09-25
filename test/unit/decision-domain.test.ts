import { describe, it, expect } from "vitest";
import type { DecisionElement } from "../../src/flows/decision.js";
import { cloudControlDescription, controlSignature, decisionQuestions, filterAuthCandidates, hasTrustedDecisionTarget, interactiveSelector, isTrustedAuthenticationUrl, normalizeDecision, rankLocalCandidates, scoreLocalRanker } from "../../src/flows/decision.js";

function makeElement(index: number, description: string, editable = false): DecisionElement {
  return {
    index,
    description,
    editable,
    observedUrl: "https://example.com",
    locator: {} as never,
  };
}

describe("decision auth domain gate", () => {
  it("observes visible account links for engine discovery", () => {
    expect(interactiveSelector).toContain("a[href]");
  });

  it("allows store and Shopify authentication targets but rejects external targets", () => {
    const storeUrl = "https://store.example";
    const observedStoreElement = { ...makeElement(0, "a · Account"), observedUrl: storeUrl };
    expect(hasTrustedDecisionTarget({ ...observedStoreElement, href: "/account/login" }, storeUrl)).toBe(true);
    expect(hasTrustedDecisionTarget({ ...makeElement(1, "a · Account"), observedUrl: "https://shopify.com/123/account", href: "https://shopify.com/123/account" }, storeUrl)).toBe(true);
    expect(isTrustedAuthenticationUrl("https://accounts.shopify.com/login", storeUrl)).toBe(true);
    expect(hasTrustedDecisionTarget({ ...makeElement(2, "a · Sign in"), href: "https://external.example/login" }, storeUrl)).toBe(false);
    expect(hasTrustedDecisionTarget({ ...makeElement(3, "input · Email", true), formAction: "https://external.example/login" }, storeUrl)).toBe(false);
    expect(hasTrustedDecisionTarget({ ...makeElement(4, "input · Email", true), observedUrl: "https://external.example/login", formAction: "/account/login" }, storeUrl)).toBe(false);
    expect(isTrustedAuthenticationUrl("http://shopify.com/account", storeUrl)).toBe(false);
  });

  it("normalizes an empty form action in control signatures", () => {
    expect(controlSignature("a", null, null, null, "https://store.example/account/login", null, false))
      .toBe(controlSignature("a", null, null, null, "https://store.example/account/login", "", false));
  });

  it("filters search, cart, and newsletter controls before model ranking", () => {
    const elements = [
      makeElement(0, "button · Search", false),
      makeElement(1, "button · My account", false),
      makeElement(2, "button · Accept cookies", false),
      makeElement(3, "input · Email address", true),
      makeElement(4, "button · Add to cart", false),
    ];

    expect(filterAuthCandidates(elements, "CLICK").map((element) => element.index)).toEqual([1]);
    expect(filterAuthCandidates(elements, "FILL_EMAIL").map((element) => element.index)).toEqual([3]);
  });

  it("fails closed when the model returns a non-auth target", () => {
    const elements = [
      makeElement(0, "button · Search", false),
      makeElement(1, "button · Add to cart", false),
    ];

    expect(() => normalizeDecision({ operation: { choice: "CLICK" }, click_target: { choice: "0" } }, elements)).toThrow(/domain-valid|invalid choice|no compatible target/i);
  });

  it("does not offer or accept email fills during the OTP stage", () => {
    const elements = [makeElement(0, "input · Email [type=email]", true), makeElement(1, "input · Code [autocomplete=one-time-code]", true)];
    expect(decisionQuestions(elements, "otp")).not.toHaveProperty("fill_email_target");
    expect(() => normalizeDecision({ operation: { choice: "FILL_EMAIL" }, fill_email_target: { choice: "0" } }, elements, "otp")).toThrow(/invalid choice/);
  });

  it("does not offer email fills during whole-page account discovery", () => {
    const elements = [makeElement(0, "input · Email [type=email]", true), makeElement(1, "a · Account", false)];
    expect(decisionQuestions(elements, "email", "page")).not.toHaveProperty("fill_email_target");
    expect(() => normalizeDecision({ operation: { choice: "FILL_EMAIL" }, fill_email_target: { choice: "0" } }, elements, "email", "page")).toThrow(/invalid choice/);
  });

  it("normalizes stale fill choices to a validated click after credentials are filled", () => {
    const elements = [{ ...makeElement(0, "button · Continue [type=submit]", false), authForm: true, formAction: "/account/login" }];
    expect(normalizeDecision({ operation: { choice: "FILL_EMAIL" } }, elements, "email", "auth", true))
      .toEqual({ target: "0", action: "CLICK" });
  });

  it("does not map a stale fill target onto multiple click controls", () => {
    const elements = [
      { ...makeElement(0, "button · Continue [type=submit]", false), authForm: true, formAction: "/account/login" },
      { ...makeElement(1, "button · Sign in [type=submit]", false), authForm: true, formAction: "/account/login" },
    ];
    expect(normalizeDecision({ operation: { choice: "FILL_EMAIL" }, fill_email_target: { choice: "0" } }, elements, "email", "auth", true))
      .toEqual({ target: "NONE", action: "WAIT" });
  });

  it("removes page context and emails from cloud decision descriptions", () => {
    expect(cloudControlDescription("input · Email {context=Customer email owner@example.test}"))
      .toBe("input · Email");
    expect(cloudControlDescription("input · Email {context=Customer email owner@example.test} · populated"))
      .toBe("input · Email · populated");
    expect(cloudControlDescription("a · Account [href=https://store.test/account?email=owner%40example.test#details]"))
      .toBe("a · Account [href=https://store.test/account]");
    expect(cloudControlDescription("a · Account [href=https://store.test/account?safe=1,token=secret#details]"))
      .toBe("a · Account [href=https://store.test/account]");
  });

  it("rejects newsletter email fields and membership controls", () => {
    const elements = [
      makeElement(0, "input · Email [type=email] {context=Newsletter signup}", true),
      makeElement(1, "a · Alliance Membership", false),
      makeElement(2, "a · Sign in", false),
      makeElement(3, "input · Email [type=email] {context=Customer login form}", true),
      makeElement(4, "button · Sign in to go to your wishlist", false),
    ];

    expect(filterAuthCandidates(elements, "CLICK").map((element) => element.index)).toEqual([2, 4]);
    expect(filterAuthCandidates(elements, "FILL_EMAIL").map((element) => element.index)).toEqual([3]);
  });

  it("retains a submit control in an authentication form after credential fill", () => {
    const elements = [
      { ...makeElement(0, "button · Continue [type=submit]", false), authForm: true, formAction: "/account/login" },
      { ...makeElement(1, "button · Close", false), authForm: true, formAction: "/account/login" },
    ];

    expect(filterAuthCandidates(elements, "CLICK").map((element) => element.index)).toEqual([0]);
  });

  it("ranks domain-valid controls with the bundled trained model", () => {
    const elements = [
      makeElement(0, "a · My account [href=/account/login]", false),
      makeElement(1, "button · Sign in to go to your wishlist", false),
      makeElement(2, "input · Email [type=email, autocomplete=email] {context=Customer login form}", true),
    ];

    expect(scoreLocalRanker(elements[0])).toBeGreaterThanOrEqual(0.5);
    expect(scoreLocalRanker(elements[2])).toBeGreaterThanOrEqual(0.5);
    expect(rankLocalCandidates(elements, "CLICK").map((element) => element.index)).toEqual([0, 1]);
    expect(rankLocalCandidates(elements, "FILL_EMAIL").map((element) => element.index)).toEqual([2]);
  });

  it("scores social links below an account entry", () => {
    const account = makeElement(0, "a · Account [href=/account/login]", false);
    const social = makeElement(1, "a · Twitter [href=https://x.com/example]", false);

    expect(scoreLocalRanker(account)).toBeGreaterThan(scoreLocalRanker(social));
  });
});

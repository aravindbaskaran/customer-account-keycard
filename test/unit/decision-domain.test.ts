import { describe, it, expect } from "vitest";
import type { DecisionElement } from "../../src/flows/decision.js";
import { filterAuthCandidates, interactiveSelector, normalizeDecision, rankLocalCandidates, scoreLocalRanker } from "../../src/flows/decision.js";

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

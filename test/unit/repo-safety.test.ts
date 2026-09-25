import { describe, expect, it } from "vitest";
import { literalApiKeyPattern } from "../../scripts/repo-safety-patterns.mjs";

describe("literal API key safety pattern", () => {
  it("detects a source literal split across one line break", () => {
    expect(literalApiKeyPattern.test('api_key\n  :\n  "abcdefghijklmnop"')).toBe(true);
  });

  it("does not join a blank environment value to the next line", () => {
    expect(literalApiKeyPattern.test("TYPESAFE_API_KEY=\n\nOTHER_VALUE=abcdefghijklmnop")).toBe(false);
  });

  it("does not treat the next environment variable name as a key", () => {
    expect(literalApiKeyPattern.test("TYPESAFE_API_KEY=\nTYPESAFE_API_URL=https://example.test")).toBe(false);
  });
});
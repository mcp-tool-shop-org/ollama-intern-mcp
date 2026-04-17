import { describe, it, expect } from "vitest";
import {
  BANNED_PHRASES,
  containsBannedPhrase,
  findBannedPhrases,
} from "../../src/guardrails/bannedPhrases.js";

describe("findBannedPhrases", () => {
  it("finds a single banned phrase", () => {
    const matches = findBannedPhrases("This tool is seamless and fast.");
    expect(matches.map((m) => m.phrase)).toContain("seamless");
  });

  it("finds multiple banned phrases across the text", () => {
    const matches = findBannedPhrases(
      "Leverage our seamless, industry-leading platform today!",
    );
    const phrases = matches.map((m) => m.phrase);
    expect(phrases).toContain("seamless");
    expect(phrases).toContain("industry-leading");
    expect(phrases.some((p) => p.toLowerCase() === "leverage")).toBe(true);
  });

  it("is case-insensitive", () => {
    const matches = findBannedPhrases("EFFORTLESS experience, BLAZING FAST results");
    const phrases = matches.map((m) => m.phrase);
    expect(phrases).toContain("effortless");
    expect(phrases).toContain("blazing fast");
  });

  it("returns empty array for clean prose", () => {
    const matches = findBannedPhrases(
      "The parser reads UTF-8 input, validates against the schema, and emits a JSON envelope.",
    );
    expect(matches).toEqual([]);
  });

  it("matches on whole words only — no false positives on substrings", () => {
    // "robustify" should not match "robust"
    const matches = findBannedPhrases("We robustify the parser.");
    expect(matches.map((m) => m.phrase)).not.toContain("robust");
  });

  it("does not match 'unlocksmith'-style substring false positives", () => {
    const matches = findBannedPhrases("The unlocksmith repaired the door.");
    expect(matches).toEqual([]);
  });

  it("handles multi-word banned phrases with internal whitespace flex", () => {
    const matches = findBannedPhrases("our blazing  fast database");
    expect(matches.some((m) => m.phrase === "blazing fast")).toBe(true);
  });

  it("matches 'cutting-edge' (hyphenated form)", () => {
    const matches = findBannedPhrases("Our cutting-edge design.");
    expect(matches.map((m) => m.phrase)).toContain("cutting-edge");
  });

  it("returns match indices pointing at the occurrence", () => {
    const text = "The seamless flow.";
    const matches = findBannedPhrases(text);
    const seamless = matches.find((m) => m.phrase === "seamless");
    expect(seamless).toBeDefined();
    expect(text.toLowerCase().slice(seamless!.index, seamless!.index + "seamless".length)).toBe(
      "seamless",
    );
  });

  it("accepts a custom list override", () => {
    const matches = findBannedPhrases("fizz buzz banter", ["fizz", "buzz"]);
    expect(matches.map((m) => m.phrase).sort()).toEqual(["buzz", "fizz"]);
  });
});

describe("containsBannedPhrase", () => {
  it("returns true when at least one phrase is present", () => {
    expect(containsBannedPhrase("we empower developers")).toBe(true);
  });

  it("returns false for clean prose", () => {
    expect(
      containsBannedPhrase("The server reads source files and returns a digest."),
    ).toBe(false);
  });
});

describe("BANNED_PHRASES list integrity", () => {
  it("includes the core sludge words from the runbook", () => {
    for (const core of ["blazing fast", "seamless", "leverage", "effortless", "empower"]) {
      expect(BANNED_PHRASES.includes(core as (typeof BANNED_PHRASES)[number])).toBe(true);
    }
  });

  it("is frozen so callers cannot mutate the default list", () => {
    expect(Object.isFrozen(BANNED_PHRASES)).toBe(true);
  });
});

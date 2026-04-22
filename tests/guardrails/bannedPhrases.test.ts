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

describe("findBannedPhrases regex-escape contract", () => {
  // Locks in the escape contract documented in bannedPhrases.ts:
  // every phrase containing JavaScript regex metacharacters must be
  // matched literally, not interpreted as a pattern. If someone "optimizes"
  // the escape and drops a character, these tests fail.
  it("matches a literal phrase containing regex metachars verbatim", () => {
    const metaPhrase = "a.*+?{}()[]\\|^$b";
    const list = [metaPhrase];
    // Exact (lowercased) occurrence present → must match.
    const matches = findBannedPhrases(
      `warning: we shipped ${metaPhrase} in the release`,
      list,
    );
    expect(matches.map((m) => m.phrase)).toContain(metaPhrase);
  });

  it("does NOT treat regex metachars in a phrase as a pattern (no false-positive match on a would-be-regex-match string)", () => {
    // The phrase "foo.bar" should NOT match "fooxbar" — `.` must be literal.
    const list = ["foo.bar"];
    const matches = findBannedPhrases("fooxbar is fine here", list);
    expect(matches).toEqual([]);
  });

  it("treats a phrase with backslashes as a literal (no escape injection)", () => {
    // Phrase `bad\d` should match the literal six-char sequence, not \d as a regex class.
    const list = ["bad\\d"];
    const hit = findBannedPhrases("we shipped bad\\d in the log", list);
    expect(hit.length).toBe(1);
    const miss = findBannedPhrases("we shipped bad9 in the log", list);
    expect(miss).toEqual([]);
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

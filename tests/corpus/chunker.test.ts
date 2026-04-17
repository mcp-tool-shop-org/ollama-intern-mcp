import { describe, it, expect } from "vitest";
import { chunk, DEFAULT_CHUNK } from "../../src/corpus/chunker.js";

describe("chunker", () => {
  it("returns empty array for empty text", () => {
    expect(chunk("")).toEqual([]);
  });

  it("returns single chunk when text fits in one window", () => {
    const text = "a".repeat(500);
    const chunks = chunk(text, { chunk_chars: 800, chunk_overlap: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].char_start).toBe(0);
    expect(chunks[0].char_end).toBe(500);
  });

  it("splits with overlap when text exceeds window", () => {
    const text = "a".repeat(2000);
    const chunks = chunk(text, { chunk_chars: 800, chunk_overlap: 100 });
    // 2000 chars, window 800, step 700: chunks at [0,800], [700,1500], [1400,2000]
    expect(chunks).toHaveLength(3);
    expect(chunks[0].char_start).toBe(0);
    expect(chunks[0].char_end).toBe(800);
    expect(chunks[1].char_start).toBe(700); // overlap of 100
    expect(chunks[1].char_end).toBe(1500);
    expect(chunks[2].char_end).toBe(2000);
  });

  it("preserves exact text at chunk boundaries", () => {
    const text = "abcdefghij".repeat(100); // 1000 chars
    const chunks = chunk(text, { chunk_chars: 500, chunk_overlap: 100 });
    expect(chunks[0].text).toBe(text.slice(0, 500));
    expect(chunks[1].text).toBe(text.slice(400, 900));
    expect(chunks[2].text).toBe(text.slice(800, 1000));
  });

  it("has monotonically increasing indices", () => {
    const text = "x".repeat(5000);
    const chunks = chunk(text);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(chunks[i - 1].index + 1);
    }
  });

  it("clamps overlap to at most half the window (never pathological)", () => {
    const text = "y".repeat(2000);
    // Request silly overlap: 900 of 800 — clamp to 400.
    const chunks = chunk(text, { chunk_chars: 800, chunk_overlap: 900 });
    // Step = 800 - 400 = 400; 2000/400 = 5 chunks max
    expect(chunks.length).toBeLessThanOrEqual(6);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });
});

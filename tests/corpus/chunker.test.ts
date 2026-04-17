import { describe, it, expect } from "vitest";
import { chunk, chunkDocument, DEFAULT_CHUNK } from "../../src/corpus/chunker.js";

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

describe("chunkDocument — heading-aware", () => {
  it("returns empty result for empty text", () => {
    expect(chunkDocument("")).toEqual({ title: null, chunks: [] });
  });

  it("extracts title from first H1 after frontmatter", () => {
    const doc = [
      "---",
      "name: foo",
      "type: test",
      "---",
      "# The Real Title",
      "",
      "Some paragraph here.",
      "",
      "## A subsection",
      "",
      "More words.",
    ].join("\n");
    const { title, chunks } = chunkDocument(doc);
    expect(title).toBe("The Real Title");
    expect(chunks.some((c) => c.chunk_type === "frontmatter")).toBe(true);
    expect(chunks.find((c) => c.chunk_type === "frontmatter")!.heading_path).toEqual([]);
  });

  it("title is null when document has no H1", () => {
    const doc = "## Only subheadings\n\nBody text.\n";
    const { title } = chunkDocument(doc);
    expect(title).toBeNull();
  });

  it("attaches heading_path for nested sections", () => {
    const doc = [
      "# Top",
      "intro paragraph",
      "",
      "## Middle",
      "middle body",
      "",
      "### Deep",
      "deep body",
      "",
      "## Sibling",
      "sibling body",
    ].join("\n");
    const { chunks } = chunkDocument(doc);
    const deep = chunks.find((c) => c.text.includes("deep body"))!;
    expect(deep.heading_path).toEqual(["Top", "Middle", "Deep"]);
    const sibling = chunks.find((c) => c.text.includes("sibling body"))!;
    expect(sibling.heading_path).toEqual(["Top", "Sibling"]);
    const intro = chunks.find((c) => c.text.includes("intro paragraph"))!;
    expect(intro.heading_path).toEqual(["Top"]);
  });

  it("preserves fenced code blocks intact, never splits them", () => {
    const big = Array.from({ length: 60 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const doc = ["# Section", "", "```ts", big, "```", "", "after"].join("\n");
    const { chunks } = chunkDocument(doc, { chunk_chars: 200, chunk_overlap: 20 });
    const codeChunks = chunks.filter((c) => c.chunk_type === "code");
    expect(codeChunks).toHaveLength(1);
    expect(codeChunks[0].text).toContain("const x0 = 0;");
    expect(codeChunks[0].text).toContain("const x59 = 59;");
  });

  it("classifies list-majority sections as 'list'", () => {
    const doc = [
      "# Things",
      "- one",
      "- two",
      "- three",
      "- four",
    ].join("\n");
    const { chunks } = chunkDocument(doc);
    const body = chunks.find((c) => c.text.includes("- one"))!;
    expect(body.chunk_type).toBe("list");
  });

  it("does not cross heading boundaries when size-splitting", () => {
    const big = "lorem ipsum dolor sit amet ".repeat(40); // ~1080 chars
    const doc = [
      "# Alpha",
      big,
      "",
      "# Bravo",
      "short",
    ].join("\n");
    const { chunks } = chunkDocument(doc, { chunk_chars: 400, chunk_overlap: 50 });
    for (const c of chunks) {
      expect(c.heading_path.length).toBeGreaterThan(0);
    }
    // No chunk straddles the Alpha->Bravo divide
    const mixedHeadings = new Set(chunks.map((c) => c.heading_path.join(">")));
    expect(mixedHeadings.has("Alpha")).toBe(true);
    expect(mixedHeadings.has("Bravo")).toBe(true);
    // Alpha chunks never contain Bravo content and vice versa
    for (const c of chunks) {
      if (c.heading_path[0] === "Alpha") expect(c.text).not.toContain("Bravo");
      if (c.heading_path[0] === "Bravo") expect(c.text).not.toContain("lorem ipsum");
    }
  });

  it("char offsets align with source text for each chunk", () => {
    const doc = ["# A", "alpha body", "", "# B", "bravo body"].join("\n");
    const { chunks } = chunkDocument(doc);
    for (const c of chunks) {
      // Slice source at the reported range; the chunk's text must be
      // contained within that source slice (modulo trimmed whitespace).
      const srcSlice = doc.slice(c.char_start, c.char_end);
      expect(srcSlice).toContain(c.text.trim().slice(0, 5));
    }
  });

  it("frontmatter without closing --- is not swallowed", () => {
    const doc = "---\nkey: val\n\n# Real Title\nbody\n";
    const { title, chunks } = chunkDocument(doc);
    // No valid frontmatter → no frontmatter chunk, title still found
    expect(chunks.some((c) => c.chunk_type === "frontmatter")).toBe(false);
    expect(title).toBe("Real Title");
  });

  it("indexes are monotonically increasing across the whole document", () => {
    const doc = [
      "# A",
      "x",
      "# B",
      "y",
      "## C",
      "z",
    ].join("\n");
    const { chunks } = chunkDocument(doc);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(chunks[i - 1].index + 1);
    }
  });
});

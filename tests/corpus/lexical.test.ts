import { describe, it, expect } from "vitest";
import {
  tokenize,
  tokenizePath,
  tokenizeHeadings,
  buildLexicalIndex,
  scoreLexical,
  isStopword,
} from "../../src/corpus/lexical.js";
import type { CorpusChunk } from "../../src/corpus/storage.js";

function mkChunk(opts: {
  id: string;
  path: string;
  chunk_index: number;
  text: string;
  heading_path?: string[];
  chunk_type?: CorpusChunk["chunk_type"];
}): CorpusChunk {
  return {
    id: opts.id,
    path: opts.path,
    file_hash: "sha256:test",
    file_mtime: "2026-04-17T00:00:00.000Z",
    chunk_index: opts.chunk_index,
    char_start: 0,
    char_end: opts.text.length,
    text: opts.text,
    vector: [],
    heading_path: opts.heading_path ?? [],
    chunk_type: opts.chunk_type ?? "paragraph",
  };
}

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric", () => {
    expect(tokenize("Hello, World! 123-abc")).toEqual(["hello", "world", "123", "abc"]);
  });

  it("drops stopwords", () => {
    expect(tokenize("the quick brown fox of the day")).toEqual(["quick", "brown", "fox", "day"]);
  });

  it("returns empty array for empty or stopword-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("the a an of to")).toEqual([]);
  });

  it("preserves digits as tokens", () => {
    expect(tokenize("v1.2.3 build 42")).toEqual(["v1", "2", "3", "build", "42"]);
  });

  it("tokenizePath splits dirs/dots/dashes/underscores", () => {
    const tokens = tokenizePath("C:/Users/mikey/memory/foo_bar-baz.md");
    expect(tokens).toContain("users");
    expect(tokens).toContain("mikey");
    expect(tokens).toContain("memory");
    expect(tokens).toContain("foo");
    expect(tokens).toContain("bar");
    expect(tokens).toContain("baz");
    expect(tokens).toContain("md");
  });

  it("tokenizeHeadings flattens the breadcrumb stack", () => {
    expect(tokenizeHeadings(["Top Section", "Sub", "Deep Bit"])).toEqual([
      "top", "section", "sub", "deep", "bit",
    ]);
  });

  it("isStopword agrees with tokenize stopword filtering", () => {
    expect(isStopword("the")).toBe(true);
    expect(isStopword("banana")).toBe(false);
  });
});

describe("scoreLexical — BM25 over v2 chunks", () => {
  it("ranks a chunk with the query term in its body above chunks without", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/a.md", chunk_index: 0, text: "alpha content about felines purring loudly" }),
      mkChunk({ id: "c-000001", path: "/x/b.md", chunk_index: 0, text: "bravo content about dogs barking" }),
      mkChunk({ id: "c-000002", path: "/x/c.md", chunk_index: 0, text: "gamma content about birds chirping" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const results = scoreLexical("felines", index);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("/x/a.md");
  });

  it("multi-term: more matched query terms produces higher score", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/many.md", chunk_index: 0, text: "ocelot jaguar lynx bobcat caracal" }),
      mkChunk({ id: "c-000001", path: "/x/one.md", chunk_index: 0, text: "ocelot alone without company here" }),
      mkChunk({ id: "c-000002", path: "/x/none.md", chunk_index: 0, text: "unrelated content about waterfalls" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const results = scoreLexical("ocelot jaguar lynx bobcat", index);
    expect(results[0].path).toBe("/x/many.md");
    expect(results[1].path).toBe("/x/one.md");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("exact phrase present in body outranks single-term-only match", () => {
    // Both chunks contain "orchestration"; only one also contains "delegation".
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/both.md", chunk_index: 0, text: "delegation orchestration patterns for small teams" }),
      mkChunk({ id: "c-000001", path: "/x/one.md", chunk_index: 0, text: "orchestration alone without the sibling word" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const results = scoreLexical("delegation orchestration", index);
    expect(results[0].path).toBe("/x/both.md");
  });

  it("path-token matches contribute to score", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/repo/memory/feedback_testing.md", chunk_index: 0, text: "body text without the special word" }),
      mkChunk({ id: "c-000001", path: "/repo/other/random.md", chunk_index: 0, text: "completely unrelated body content" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const results = scoreLexical("feedback", index);
    expect(results[0].path).toBe("/repo/memory/feedback_testing.md");
    expect(results[0].fieldScores.path).toBeGreaterThan(0);
  });

  it("heading_path match contributes to heading field score", () => {
    const chunks = [
      mkChunk({
        id: "c-000000",
        path: "/x/a.md",
        chunk_index: 0,
        text: "body without the target term",
        heading_path: ["Corpus Architecture", "Retrieval"],
      }),
      mkChunk({
        id: "c-000001",
        path: "/x/b.md",
        chunk_index: 0,
        text: "retrieval is mentioned here in the body",
        heading_path: ["Unrelated Chapter"],
      }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const results = scoreLexical("retrieval", index);
    // Both match — heading match vs body match. Both should score > 0.
    const a = results.find((r) => r.path === "/x/a.md")!;
    expect(a.fieldScores.heading).toBeGreaterThan(0);
    const b = results.find((r) => r.path === "/x/b.md")!;
    expect(b.fieldScores.body).toBeGreaterThan(0);
  });

  it("title match contributes to title field score and boosts combined ranking", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/titled.md", chunk_index: 0, text: "a generic intro paragraph with no surface hits" }),
      mkChunk({ id: "c-000001", path: "/x/plain.md", chunk_index: 0, text: "flamingo appears exactly once here in the body" }),
    ];
    const index = buildLexicalIndex(chunks, {
      "/x/titled.md": "Flamingo Handbook",
      "/x/plain.md": null,
    });
    const results = scoreLexical("flamingo", index);
    // Title-boosted doc should outrank a body-only hit.
    expect(results[0].path).toBe("/x/titled.md");
    expect(results[0].fieldScores.title).toBeGreaterThan(0);
  });

  it("stopwords in the query do not produce spurious matches", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/a.md", chunk_index: 0, text: "the the the the the the the" }),
      mkChunk({ id: "c-000001", path: "/x/b.md", chunk_index: 0, text: "mongoose appears uniquely here" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    // Query is all stopwords plus one real term.
    const results = scoreLexical("the of to mongoose", index);
    // Stopword-only chunk should not score; mongoose chunk should.
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("/x/b.md");
  });

  it("query that is all stopwords returns empty results", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/a.md", chunk_index: 0, text: "any body content" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    expect(scoreLexical("the of to a an", index)).toEqual([]);
  });

  it("is deterministic: same input produces identical output", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/a.md", chunk_index: 0, text: "alpha beta gamma" }),
      mkChunk({ id: "c-000001", path: "/x/b.md", chunk_index: 0, text: "alpha delta epsilon" }),
      mkChunk({ id: "c-000002", path: "/x/c.md", chunk_index: 0, text: "gamma zeta eta" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const r1 = scoreLexical("alpha gamma", index);
    const r2 = scoreLexical("alpha gamma", index);
    expect(r1).toEqual(r2);
  });

  it("stable tie-break: identical scores break by (path asc, chunk_index asc)", () => {
    // Identical body text across two paths → identical field scores per field.
    const text = "lexical tie break test";
    const chunks = [
      mkChunk({ id: "c-zzzz01", path: "/z/last.md", chunk_index: 0, text }),
      mkChunk({ id: "c-aaaa01", path: "/a/first.md", chunk_index: 0, text }),
      mkChunk({ id: "c-mmmm01", path: "/a/first.md", chunk_index: 5, text }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const results = scoreLexical("lexical tie", index);
    expect(results).toHaveLength(3);
    // All three scores equal → sort by path asc, then chunk_index asc.
    expect(results[0].path).toBe("/a/first.md");
    expect(results[0].chunkIndex).toBe(0);
    expect(results[1].path).toBe("/a/first.md");
    expect(results[1].chunkIndex).toBe(5);
    expect(results[2].path).toBe("/z/last.md");
  });

  it("is case-insensitive on both query and document side", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/a.md", chunk_index: 0, text: "The QUICK brown FOX" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const lower = scoreLexical("quick", index);
    const upper = scoreLexical("QUICK", index);
    expect(lower).toHaveLength(1);
    expect(upper).toHaveLength(1);
    expect(lower[0].score).toBe(upper[0].score);
  });

  it("empty query returns empty results", () => {
    const chunks = [mkChunk({ id: "c-000000", path: "/x/a.md", chunk_index: 0, text: "hello" })];
    const index = buildLexicalIndex(chunks, {});
    expect(scoreLexical("", index)).toEqual([]);
  });

  it("empty index returns empty results", () => {
    const index = buildLexicalIndex([], {});
    expect(scoreLexical("anything", index)).toEqual([]);
  });

  it("preserves per-field scores on every result for slice 3 recombination", () => {
    const chunks = [
      mkChunk({
        id: "c-000000",
        path: "/repo/retrieval/design.md",
        chunk_index: 0,
        text: "retrieval retrieval retrieval body mentions",
        heading_path: ["Retrieval Design"],
      }),
    ];
    const index = buildLexicalIndex(chunks, { "/repo/retrieval/design.md": "Retrieval Handbook" });
    const [hit] = scoreLexical("retrieval", index);
    expect(hit.fieldScores.title).toBeGreaterThan(0);
    expect(hit.fieldScores.heading).toBeGreaterThan(0);
    expect(hit.fieldScores.path).toBeGreaterThan(0);
    expect(hit.fieldScores.body).toBeGreaterThan(0);
    // Combined score equals weighted sum, not any single field alone.
    const sum =
      3.0 * hit.fieldScores.title +
      2.0 * hit.fieldScores.heading +
      1.5 * hit.fieldScores.path +
      1.0 * hit.fieldScores.body;
    expect(hit.score).toBeCloseTo(sum, 6);
  });

  it("custom weights override defaults without changing field scores", () => {
    const chunks = [
      mkChunk({
        id: "c-000000",
        path: "/repo/memory/x.md",
        chunk_index: 0,
        text: "body text lacking the term",
        heading_path: [],
      }),
    ];
    const index = buildLexicalIndex(chunks, { "/repo/memory/x.md": "target phrase" });
    const def = scoreLexical("target", index);
    const titleOnly = scoreLexical("target", index, { weights: { title: 10, body: 0, heading: 0, path: 0 } });
    expect(def[0].fieldScores.title).toBe(titleOnly[0].fieldScores.title);
    expect(titleOnly[0].score).toBeCloseTo(10 * titleOnly[0].fieldScores.title, 6);
  });

  it("matchedTerms lists only terms actually matched, sorted", () => {
    const chunks = [
      mkChunk({ id: "c-000000", path: "/x/a.md", chunk_index: 0, text: "alpha bravo" }),
    ];
    const index = buildLexicalIndex(chunks, {});
    const [hit] = scoreLexical("alpha bravo charlie", index);
    expect(hit.matchedTerms).toEqual(["alpha", "bravo"]);
  });
});

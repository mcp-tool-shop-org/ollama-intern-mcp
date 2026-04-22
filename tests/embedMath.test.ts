import { describe, it, expect } from "vitest";
import { cosine, rankByCosine } from "../src/embedMath.js";
import { InternError } from "../src/errors.js";

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosine([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("throws EMBED_DIMENSION_MISMATCH on length mismatch (catches :latest drift, mixed-model corpora)", () => {
    let caught: InternError | undefined;
    try {
      cosine([1, 2], [1, 2, 3]);
    } catch (err) {
      caught = err as InternError;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect(caught!.code).toBe("EMBED_DIMENSION_MISMATCH");
    // Dimensions appear in the message so the operator can see both sides.
    expect(caught!.message).toContain("2d");
    expect(caught!.message).toContain("3d");
    expect(caught!.hint).toContain("Re-index");
    expect(caught!.retryable).toBe(false);
  });

  it("returns 0 for empty vectors (both sides zero-length)", () => {
    expect(cosine([], [])).toBe(0);
  });
});

describe("rankByCosine", () => {
  it("sorts descending by similarity to the query", () => {
    const ranked = rankByCosine(
      [1, 0],
      [
        { item: "opposite", vec: [-1, 0] },
        { item: "same", vec: [1, 0] },
        { item: "orthogonal", vec: [0, 1] },
      ],
    );
    expect(ranked[0].item).toBe("same");
    expect(ranked[1].item).toBe("orthogonal");
    expect(ranked[2].item).toBe("opposite");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it("breaks ties by original index (stable, deterministic)", () => {
    const ranked = rankByCosine(
      [1, 0],
      [
        { item: "a", vec: [1, 0] },
        { item: "b", vec: [1, 0] },
        { item: "c", vec: [1, 0] },
      ],
    );
    expect(ranked.map((r) => r.item)).toEqual(["a", "b", "c"]);
  });

  it("preserves original index on the RankedCandidate", () => {
    const ranked = rankByCosine(
      [1, 0],
      [
        { item: "first", vec: [0, 1] },
        { item: "second", vec: [1, 0] },
      ],
    );
    expect(ranked[0].item).toBe("second");
    expect(ranked[0].originalIndex).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../src/llm-connector.ts";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [0.1, 0.2, 0.3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched length vectors", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("computes correct similarity for known vectors", () => {
    const a = [1, 0, 0];
    const b = [1, 1, 0];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(0.7071, 3);
  });

  it("is symmetric: sim(a,b) === sim(b,a)", () => {
    const a = [0.5, 0.3, 0.8];
    const b = [0.2, 0.7, 0.4];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
  });

  it("returns positive for positive vectors", () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("handles large vectors", () => {
    const a = Array(100).fill(0.1);
    const b = Array(100).fill(0.1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it("returns 0 when one vector is all zeros", () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});
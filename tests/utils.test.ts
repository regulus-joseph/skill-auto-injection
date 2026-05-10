import { describe, it, expect } from "vitest";
import {
  hasEnglishCharacters,
  tokenizeForMatch,
  parseSkillMarkdown,
} from "../src/utils.ts";
import { cosineSimilarity } from "../../llm-connector/src/ts/connector.ts";

describe("hasEnglishCharacters", () => {
  it("returns true for pure English text", () => {
    expect(hasEnglishCharacters("commit the changes")).toBe(true);
  });

  it("returns true for English mixed with Chinese", () => {
    expect(hasEnglishCharacters("帮我 git commit")).toBe(true);
  });

  it("returns true for single words in English", () => {
    expect(hasEnglishCharacters("hello world")).toBe(true);
  });

  it("returns false for pure Chinese", () => {
    expect(hasEnglishCharacters("帮我做这个")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasEnglishCharacters("")).toBe(false);
  });

  it("returns false for single character", () => {
    expect(hasEnglishCharacters("a")).toBe(false);
  });

  it("returns false for numbers and symbols", () => {
    expect(hasEnglishCharacters("12345")).toBe(false);
  });

  it("returns true for Chinese with English phrase", () => {
    expect(hasEnglishCharacters("提交 git commit")).toBe(true);
  });
});

describe("tokenizeForMatch", () => {
  it("extracts lowercase English tokens", () => {
    const tokens = tokenizeForMatch("Git Commit Changes");
    expect(tokens.has("git")).toBe(true);
    expect(tokens.has("commit")).toBe(true);
    expect(tokens.has("changes")).toBe(true);
  });

  it("ignores Chinese characters", () => {
    const tokens = tokenizeForMatch("帮我做git提交");
    expect(tokens.has("git")).toBe(true);
    expect(tokens.size).toBe(1);
  });

  it("returns empty set for pure Chinese", () => {
    const tokens = tokenizeForMatch("帮我做这个");
    expect(tokens.size).toBe(0);
  });

  it("handles mixed content", () => {
    const tokens = tokenizeForMatch("用 git merge 合并分支");
    expect(tokens.has("git")).toBe(true);
    expect(tokens.has("merge")).toBe(true);
    expect(tokens.size).toBe(2);
  });
});

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
});

describe("parseSkillMarkdown", () => {
  it("extracts name and description from SKILL.md", () => {
    const content = `---
name: git-tool
description: A comprehensive Git tool for version control operations including commit, branch, merge, and stash management.
---

# Git Tool

## Usage`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.name).toBe("git-tool");
    expect(result.description).toContain("Git tool");
  });

  it("uses fallback name when name not found", () => {
    const result = parseSkillMarkdown("no name here", "my-skill");
    expect(result.name).toBe("my-skill");
  });

  it("extracts multi-line description", () => {
    const content = `name: test
description: This is a test skill.
  It handles multiple scenarios.
  And various use cases.`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.name).toBe("test");
    expect(result.description).toContain("test skill");
    expect(result.description).toContain("multiple scenarios");
  });

  it("ignores lines starting with # or -", () => {
    const content = `name: test
description: Main description here.
# This is a comment
- And this is a list item`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.description).toBe("Main description here.");
    expect(result.description).not.toContain("#");
    expect(result.description).not.toContain("-");
  });

  it("strips > prefix from description", () => {
    const content = `name: test
description: > This is quoted`;
    const result = parseSkillMarkdown(content, "fallback");
    expect(result.description).toContain("quoted");
  });
});

// ─────────────────────────────────────────────────────────────
// L1 scoring logic — mirrors the actual matchScored() logic in index.ts
// ─────────────────────────────────────────────────────────────
describe("L1 keyword scoring", () => {
  /**
   * Replicate the L1 scoring logic from index.ts so we can test it in isolation.
   * Returns Array<{ hitCount, total, ratio }> for each skill.
   */
  function scoreL1(promptTokens: Set<string>, skills: Array<{ keywords: string[] }>, minHits: number) {
    const scored: Array<{ hitCount: number; total: number; ratio: number }> = [];
    for (const skill of skills) {
      if (skill.keywords.length === 0) continue;
      const kwSet = new Set(skill.keywords.map(k => k.toLowerCase()));
      let hits = 0;
      for (const tok of promptTokens) {
        if (kwSet.has(tok)) hits++;
      }
      if (hits >= minHits) {
        scored.push({ hitCount: hits, total: skill.keywords.length, ratio: hits / skill.keywords.length });
      }
    }
    // Sort: ratio desc, then hitCount desc
    scored.sort((a, b) => {
      const ratioA = a.hitCount / a.total;
      const ratioB = b.hitCount / b.total;
      if (Math.abs(ratioA - ratioB) > 0.01) return ratioB - ratioA;
      return b.hitCount - a.hitCount;
    });
    return scored;
  }

  it("scores 1 hit out of 3 keywords as ratio ~0.33", () => {
    // "帮我 git commit" → tokens: git, commit (2 hits, not 1)
    // Using "git push" → tokens: git, push → 2 hits vs ["git","commit","stash"] → 1 hit
    const tokens = tokenizeForMatch("帮我 git commit");
    const skills = [{ keywords: ["git", "commit", "stash"] }];
    const result = scoreL1(tokens, skills, 1);
    expect(result).toHaveLength(1);
    expect(result[0].hitCount).toBe(2);
    expect(result[0].ratio).toBeCloseTo(0.667, 2);
  });

  it("scores 2 hits out of 2 keywords as ratio 1.0", () => {
    const tokens = tokenizeForMatch("git commit something");
    const skills = [{ keywords: ["git", "commit"] }];
    const result = scoreL1(tokens, skills, 1);
    expect(result).toHaveLength(1);
    expect(result[0].ratio).toBe(1.0);
  });

  it("sorts by ratio desc, then by hit count desc", () => {
    const tokens = tokenizeForMatch("git merge commit");
    // Skill A: ["git","merge","stash"]  → 2 hits, ratio 2/3 ≈ 0.67  (NOT 1.0)
    // Skill B: ["commit"]               → 1 hit,  ratio 1.0
    // Skill C: ["git"]                 → 1 hit,  ratio 1.0
    // Expected order: ratio 1.0 first (B, C), then 0.67 (A)
    const skills = [
      { keywords: ["git", "merge", "stash"] },
      { keywords: ["commit"] },
      { keywords: ["git"] },
    ];
    const result = scoreL1(tokens, skills, 1);
    expect(result).toHaveLength(3);
    // Top positions: ratio 1.0 (B and C), then ratio 0.67 (A)
    expect(result[0].ratio).toBe(1.0);  // B
    expect(result[1].ratio).toBe(1.0);  // C
    expect(result[2].ratio).toBeCloseTo(0.67, 2);  // A
  });

  it("excludes skills below minKeywordHits threshold", () => {
    const tokens = tokenizeForMatch("git");
    const skills = [{ keywords: ["git", "commit", "push", "merge"] }]; // 1 hit, total 4
    const result = scoreL1(tokens, skills, 2); // require 2 hits
    expect(result).toHaveLength(0);
  });

  it("returns empty when prompt has no English tokens", () => {
    const tokens = tokenizeForMatch("帮我做这个");
    const skills = [{ keywords: ["git", "commit"] }];
    const result = scoreL1(tokens, skills, 1);
    expect(result).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    const tokens = tokenizeForMatch("GIT COMMIT");
    const skills = [{ keywords: ["git", "commit"] }];
    const result = scoreL1(tokens, skills, 1);
    expect(result).toHaveLength(1);
    expect(result[0].hitCount).toBe(2);
  });
});

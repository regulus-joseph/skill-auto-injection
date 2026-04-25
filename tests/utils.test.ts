import { describe, it, expect } from "vitest";
import {
  hasEnglishCharacters,
  tokenizeForMatch,
  keywordMatch,
  cosineSimilarity,
  parseSkillMarkdown,
} from "../src/utils.ts";

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

describe("keywordMatch", () => {
  it("matches exact keyword", () => {
    expect(keywordMatch("help me with git commit", ["git", "commit", "version"])).toBe(true);
  });

  it("matches partial keyword", () => {
    expect(keywordMatch("create a new branch for me", ["branch", "git"])).toBe(true);
  });

  it("no match when keywords empty", () => {
    expect(keywordMatch("help me with something", [])).toBe(false);
  });

  it("no match when query has no English", () => {
    expect(keywordMatch("帮我做这个", ["git", "commit"])).toBe(false);
  });

  it("no match when no keyword overlap", () => {
    expect(keywordMatch("make coffee", ["git", "commit"])).toBe(false);
  });

  it("case insensitive matching", () => {
    expect(keywordMatch("GIT COMMIT", ["git", "commit"])).toBe(true);
  });

  it("multi-word keywords are matched as-is against tokenized query", () => {
    expect(keywordMatch("use version control", ["version"])).toBe(true);
    expect(keywordMatch("use version control", ["control"])).toBe(true);
    expect(keywordMatch("use version control", ["version control"])).toBe(false);
  });

  it("matches git mixed with Chinese", () => {
    expect(keywordMatch("帮我做 git commit", ["git", "commit"])).toBe(true);
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

describe("L1+L2 cascade logic", () => {
  it("L1 keyword match short-circuits to L2 embed", () => {
    const query = "帮我做git提交";
    const keywords = ["git", "commit"];
    const hasEn = hasEnglishCharacters(query);
    const matched = keywordMatch(query, keywords);

    expect(hasEn).toBe(true);
    expect(matched).toBe(true);
  });

  it("L1 no match, L2 embed fallback for pure Chinese", () => {
    const query = "帮我做这个复杂的任务";
    const keywords = ["python", "script"];
    const hasEn = hasEnglishCharacters(query);
    const matched = keywordMatch(query, keywords);

    expect(hasEn).toBe(false);
    expect(matched).toBe(false);
  });

  it("English query without keyword match falls to L2", () => {
    const query = "help me understand this";
    const hasEn = hasEnglishCharacters(query);
    const matched = keywordMatch(query, ["git", "commit"]);

    expect(hasEn).toBe(true);
    expect(matched).toBe(false);
  });
});

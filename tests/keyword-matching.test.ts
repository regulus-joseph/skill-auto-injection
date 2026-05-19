import { describe, it, expect } from "vitest";
import {
  hasEnglishCharacters,
  tokenizeForMatch,
  keywordMatch,
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

  it("returns true for code-like strings", () => {
    expect(hasEnglishCharacters("npm install")).toBe(true);
    expect(hasEnglishCharacters("python3 -m venv")).toBe(true);
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

  it("deduplicates tokens via Set", () => {
    const tokens = tokenizeForMatch("git commit git push git");
    expect(tokens.has("git")).toBe(true);
    expect(tokens.has("commit")).toBe(true);
    expect(tokens.has("push")).toBe(true);
    expect(tokens.size).toBe(3);
  });

  it("handles camelCase as single token", () => {
    const tokens = tokenizeForMatch("gitCommit");
    expect(tokens.has("gitcommit")).toBe(true);
    expect(tokens.size).toBe(1);
  });

  it("handles kebab-case", () => {
    const tokens = tokenizeForMatch("git-commit");
    expect(tokens.has("git")).toBe(true);
    expect(tokens.has("commit")).toBe(true);
  });
});

describe("keywordMatch", () => {
  it("returns true when query token matches skill keyword", () => {
    expect(keywordMatch("帮我 git commit", ["git", "commit", "stash"])).toBe(true);
  });

  it("returns false when no keywords match", () => {
    expect(keywordMatch("帮我做这个", ["git", "commit"])).toBe(false);
  });

  it("returns false for empty skill keywords", () => {
    expect(keywordMatch("git commit", [])).toBe(false);
  });

  it("returns false for empty query", () => {
    expect(keywordMatch("", ["git", "commit"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(keywordMatch("GIT COMMIT", ["git", "commit"])).toBe(true);
    expect(keywordMatch("git commit", ["GIT", "COMMIT"])).toBe(true);
  });

  it("requires exact keyword match (no partial)", () => {
    expect(keywordMatch("github push", ["git", "commit"])).toBe(false);
  });
});
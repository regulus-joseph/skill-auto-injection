import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { translateToEnglish, extractKeywords } from "../src/llm-connector.ts";

const fetchSpy = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  fetchSpy.mockReset();
  vi.spyOn(global, "fetch").mockImplementation(fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("translateToEnglish", () => {
  it("returns translated text on success", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "translate the following user request" }),
    } as Response);

    const result = await translateToEnglish("翻译这句话");
    expect(result).toBe("translate the following user request");
  });

  it("returns trimmed response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "  hello world  " }),
    } as Response);

    const result = await translateToEnglish("你好世界");
    expect(result).toBe("hello world");
  });

  it("returns null on fetch error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));

    const result = await translateToEnglish("测试");
    expect(result).toBeNull();
  });

  it("returns empty string when response is empty", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "" }),
    } as Response);

    const result = await translateToEnglish("测试");
    expect(result).toBe(""); // empty string, not null
  });

  it("returns null when response field missing", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await translateToEnglish("测试");
    expect(result).toBeNull();
  });

  it("returns null on non-ok status", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const result = await translateToEnglish("测试");
    expect(result).toBeNull();
  });

  it("returns null when JSON parse fails", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new Error("Invalid JSON"); },
    } as Response);

    const result = await translateToEnglish("测试");
    expect(result).toBeNull();
  });

  it("calls correct endpoint with default config", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "test" }),
    } as Response);

    await translateToEnglish("测试");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/generate");
    const body = JSON.parse((opts as any).body);
    expect(body.model).toBe("qwen2.5:3b"); // default model
    expect(body.prompt).toContain("测试");
  });
});

describe("extractKeywords", () => {
  it("parses JSON array from LLM response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '["git", "commit", "push"]' }),
    } as Response);

    const result = await extractKeywords("Git tool for version control", "git-tool");
    expect(result).toEqual(["git", "commit", "push"]);
  });

  it("returns lowercase keywords", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '["Git", "Commit", "Push"]' }),
    } as Response);

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual(["git", "commit", "push"]);
  });

  it("trims whitespace from keywords", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '["  git  ", " commit ", "push"]' }),
    } as Response);

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual(["git", "commit", "push"]);
  });

  it("filters out non-string entries", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '["git", 123, null, "commit"]' }),
    } as Response);

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual(["git", "commit"]);
  });

  it("whitespace-only strings pass filter then become empty after trim", async () => {
    // Actual behavior: filter runs before map, so "  " passes filter (length > 0), then becomes ""
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '["git", "  ", "commit"]' }),
    } as Response);

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual(["git", "", "commit"]);
  });

  it("returns empty array when no JSON array found", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "Here are the keywords: git, commit" }),
    } as Response);

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual([]);
  });

  it("returns empty array when parsed non-array", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '{"git": true}' }),
    } as Response);

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual([]);
  });

  it("extracts array embedded in text", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: 'Here are the keywords: ["git", "commit", "version control"]' }),
    } as Response);

    const result = await extractKeywords("description", "skill");
    expect(result).toEqual(["git", "commit", "version control"]);
  });

  it("calls correct endpoint with default config", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '["test"]' }),
    } as Response);

    await extractKeywords("description", "skill");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/generate");
    const body = JSON.parse((opts as any).body);
    expect(body.model).toBe("qwen2.5:3b"); // default model
    expect(body.prompt).toContain("skill");
  });
});
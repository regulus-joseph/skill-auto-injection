/**
 * Integration tests for LLM connector - requires real Ollama instance.
 * Run with: npm test -- --grep "integration"
 * These tests are skipped by default unless Ollama is running.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getEmbedding, translateToEnglish, extractKeywords } from "../src/llm-connector.ts";

const OLLAMA_URL = "http://localhost:11434";
const TEST_TIMEOUT = 30000;

async function isOllamaRunning(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

const isRunning = await isOllamaRunning();

const describeIntegration = isRunning ? describe : describe.skip;

describeIntegration("translateToEnglish (integration)", () => {
  it("translates Chinese to English", async () => {
    const result = await translateToEnglish("翻译这句话", { baseUrl: OLLAMA_URL, llmModel: "qwen3.5:4b" });
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  it("translates Japanese to English", async () => {
    const result = await translateToEnglish("これを翻訳してください", { baseUrl: OLLAMA_URL, llmModel: "qwen3.5:4b" });
    expect(result).toBeTruthy();
    expect(result!.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
}, TEST_TIMEOUT);

describeIntegration("extractKeywords (integration)", () => {
  it("extracts keywords for git skill", async () => {
    const result = await extractKeywords(
      "Git tool for version control operations including commit, branch, merge, and stash",
      "git-tool",
      { baseUrl: OLLAMA_URL, llmModel: "qwen3.5:4b" }
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(35);
    // Should contain git-related keywords
    const lower = result.map(k => k.toLowerCase());
    expect(lower.some(k => k.includes("git") || k.includes("commit") || k.includes("version"))).toBe(true);
  }, TEST_TIMEOUT);

  it("extracts keywords for browser skill", async () => {
    const result = await extractKeywords(
      "Browser automation and web scraping tool with support for multiple pages",
      "browser-tool",
      { baseUrl: OLLAMA_URL, llmModel: "qwen3.5:4b" }
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(35);
  }, TEST_TIMEOUT);
}, TEST_TIMEOUT);

describeIntegration("getEmbedding (integration)", () => {
  it("returns embedding vector for English text", async () => {
    const embedding = await getEmbedding("git commit", { baseUrl: OLLAMA_URL, embedModel: "bge-m3" });
    expect(embedding).toBeDefined();
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(100); // bge-m3 produces 1024-dim vectors
  }, TEST_TIMEOUT);

  it("returns embedding vector for Chinese text", async () => {
    const embedding = await getEmbedding("git 提交", { baseUrl: OLLAMA_URL, embedModel: "bge-m3" });
    expect(embedding).toBeDefined();
    expect(Array.isArray(embedding));
    expect(embedding.length).toBeGreaterThan(100);
  }, TEST_TIMEOUT);

  it("returns consistent vectors for same text", async () => {
    const text = "git commit push";
    const emb1 = await getEmbedding(text, { baseUrl: OLLAMA_URL, embedModel: "bge-m3" });
    const emb2 = await getEmbedding(text, { baseUrl: OLLAMA_URL, embedModel: "bge-m3" });
    // Vectors should be very close (allow small floating point variation)
    const maxDiff = emb1.reduce((max, v, i) => Math.max(max, Math.abs(v - emb2[i])), 0);
    expect(maxDiff).toBeLessThan(0.001);
  }, TEST_TIMEOUT);
}, TEST_TIMEOUT);

describe("Ollama connectivity", () => {
  it("Ollama is running at localhost:11434", () => {
    expect(isRunning).toBe(true);
  });
});
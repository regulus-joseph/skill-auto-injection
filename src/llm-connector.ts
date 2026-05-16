/**
 * llm-connector bundled into skill-auto-injection
 * Inline version of ~/projects/llm-connector/src/ts/connector.ts
 * Default env from shared-lib/ts/config.ts
 */

// Default config (matches shared-lib/ts/config.ts)
const DEFAULT_ENV = {
  baseUrl:       process.env.OLLAMA_BASE_URL          || "http://localhost:11434",
  llmModel:     process.env.OLLAMA_LLM_MODEL        || "qwen3.5:4b",
  embedModel:   process.env.OLLAMA_EMBED_MODEL      || "bge-m3",
  embedDim:     parseInt(process.env.OLLAMA_EMBED_DIM || "1024", 10),
  timeoutMs:    parseInt(process.env.OLLAMA_TIMEOUT_MS || "30000", 10),
  embedTimeout: parseInt(process.env.OLLAMA_EMBED_TIMEOUT_MS || "60000", 10),
  retries:      parseInt(process.env.OLLAMA_RETRIES  || "2", 10),
} as const;

export interface LLMConfig {
  baseUrl?:     string;
  llmModel?:    string;
  embedModel?:  string;
  embedDim?:    number;
  timeoutMs?:   number;
  embedTimeout?: number;
  retries?:     number;
}

export interface ChatMessage {
  role:    "system" | "user" | "assistant";
  content: string;
}

function resolveConfig(cfg?: LLMConfig) {
  return {
    baseUrl:       cfg?.baseUrl       || DEFAULT_ENV.baseUrl,
    llmModel:     cfg?.llmModel     || DEFAULT_ENV.llmModel,
    embedModel:   cfg?.embedModel   || DEFAULT_ENV.embedModel,
    embedDim:     cfg?.embedDim     || DEFAULT_ENV.embedDim,
    timeoutMs:    cfg?.timeoutMs    || DEFAULT_ENV.timeoutMs,
    embedTimeout: cfg?.embedTimeout || DEFAULT_ENV.embedTimeout,
    retries:      cfg?.retries      || DEFAULT_ENV.retries,
  };
}

function stripSlash(url: string) {
  return url.replace(/\/$/, "");
}

async function fetchWithTimeout(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json() as unknown;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        console.warn(`[llm-connector] ${label} retry ${i+1}/${retries}: ${String(err)}`);
      }
    }
  }
  throw new Error(`${label} failed after ${retries+1} attempts: ${String(lastErr)}`);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const dA = Math.sqrt(nA), dB = Math.sqrt(nB);
  if (dA === 0 || dB === 0) return 0;
  return dot / (dA * dB);
}

export async function getEmbedding(
  text: string,
  cfg?: LLMConfig,
): Promise<number[]> {
  const c = resolveConfig(cfg);
  const url = `${stripSlash(c.baseUrl)}/api/embeddings`;
  try {
    const data = await fetchWithTimeout(
      url,
      { model: c.embedModel, prompt: text },
      c.embedTimeout,
    ) as { embedding?: number[] };
    return data.embedding ?? [];
  } catch {
    return [];
  }
}

export async function translateToEnglish(
  text: string,
  cfg?: LLMConfig,
): Promise<string | null> {
  const c = resolveConfig(cfg);
  const url = `${stripSlash(c.baseUrl)}/api/generate`;
  try {
    const data = await fetchWithTimeout(
      url,
      {
        model: c.llmModel,
        prompt: `Translate the following user request to English. Only respond with the translation, nothing else.\n\nUser request: ${text}`,
        stream: false,
        think: false,
      },
      c.timeoutMs,
    ) as { response?: string };
    return data.response?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function extractKeywords(
  description: string,
  skillName: string,
  cfg?: LLMConfig,
): Promise<string[]> {
  const c = resolveConfig(cfg);
  const url = `${stripSlash(c.baseUrl)}/api/generate`;
  try {
    const data = await fetchWithTimeout(
      url,
      {
        model: c.llmModel,
        prompt: `You are a keyword extractor. Given a skill description, extract 3-5 short English trigger keywords (single words or simple phrases) that users would likely type to invoke this skill. Return ONLY a JSON array of strings, nothing else.\n\nSkill name: ${skillName}\nDescription: ${description}\n\nRespond with a JSON array, e.g.: ["git", "commit", "version control"]`,
        stream: false,
        think: false,
      },
      c.timeoutMs,
    ) as { response?: string };
    const text = (data.response ?? "").trim();
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .map(k => k.toLowerCase().trim());
  } catch {
    return [];
  }
}

export async function chat(
  messages: ChatMessage[],
  cfg?: LLMConfig,
): Promise<string> {
  const c = resolveConfig(cfg);
  const url = `${stripSlash(c.baseUrl)}/api/generate`;

  const promptParts: string[] = [];
  for (const msg of messages) {
    promptParts.push(`${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}: ${msg.content}`);
  }
  promptParts.push("Assistant:");
  const prompt = promptParts.join("\n");

  const fn = async () => {
    const data = await fetchWithTimeout(
      url,
      { model: c.llmModel, prompt, stream: false, think: false },
      c.timeoutMs,
    ) as { response?: string };
    return (data.response ?? "").trim();
  };

  return withRetry(fn, c.retries, "chat");
}
/**
 * Skill Auto-Injection Plugin
 * Automatically matches user delivery task with available skills
 * using embedding similarity, and injects matched skills into context
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  cosineSimilarity,
  keywordMatch,
  hasEnglishCharacters,
  parseSkillMarkdown,
} from "./utils.js";

interface SkillAutoInjectionConfig {
  enabled?: boolean;
  embedding?: {
    baseURL?: string;
    model?: string;
    dimensions?: number;
  };
  translate?: {
    enabled?: boolean;
    provider?: "ollama" | "minimax" | "openai";
    model?: string;
  };
  matching?: {
    skillMatchThreshold?: number;
    maxSkills?: number;
  };
  keyword?: {
    enabled?: boolean;
    model?: string;
    baseURL?: string;
  };
  deliveryTaskPatterns?: string[];
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

interface CachedSkill {
  info: SkillInfo;
  embedding: number[];
  keywords: string[];
}

let cachedSkills: CachedSkill[] = [];
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function parsePluginConfig(value: unknown): SkillAutoInjectionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as SkillAutoInjectionConfig;
}

async function getEmbedding(
  text: string,
  baseUrl: string,
  model: string
): Promise<number[]> {
  try {
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.embedding ?? [];
  } catch {
    return [];
  }
}

async function translateToEnglish(
  text: string,
  config: SkillAutoInjectionConfig,
  minimaxApiKey: string,
  openaiApiKey: string
): Promise<string | null> {
  const translateConfig = config.translate ?? {};
  const provider = translateConfig.provider ?? "ollama";
  const model = translateConfig.model ?? "qwen2.5:7b";

  if (translateConfig.enabled === false) {
    return null;
  }

  switch (provider) {
    case "ollama":
      return translateWithOllama(text, config.embedding?.baseURL ?? "http://localhost:11434", model);
    case "minimax":
      return translateWithMinimax(text, minimaxApiKey);
    case "openai":
      return translateWithOpenAI(text, openaiApiKey);
    default:
      return translateWithOllama(text, config.embedding?.baseURL ?? "http://localhost:11434", model);
  }
}

async function translateWithOllama(text: string, baseUrl: string, model: string): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl.replace("/api/embeddings", "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: `Translate the following user request to English. Only respond with the translation, nothing else.\n\nUser request: ${text}`,
        stream: false,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.response?.trim() ?? null;
  } catch {
    return null;
  }
}

async function translateWithMinimax(text: string, apiKey: string): Promise<string | null> {
  if (!apiKey) {
    console.warn("[skill-auto-injection] MINIMAX_API_KEY not set for translation");
    return null;
  }
  try {
    const resp = await fetch("https://api.minimaxi.com/v1/text/chatcompletion_pro", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "abab6.5s-chat",
        messages: [
          { role: "system", content: "You are a translator. Translate the user's request to English. Only respond with the translation, nothing else." },
          { role: "user", content: text }
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

async function translateWithOpenAI(text: string, apiKey: string): Promise<string | null> {
  if (!apiKey) {
    console.warn("[skill-auto-injection] OPENAI_API_KEY not set for translation");
    return null;
  }
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a translator. Translate the user's request to English. Only respond with the translation, nothing else." },
          { role: "user", content: text }
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

async function extractKeywordsFromDescription(
  description: string,
  skillName: string,
  config: SkillAutoInjectionConfig,
  minimaxApiKey: string,
  openaiApiKey: string
): Promise<string[]> {
  const kwConfig = config.keyword ?? {};
  if (kwConfig.enabled === false) return [];

  const provider = config.translate?.provider ?? "ollama";
  const model = kwConfig.model ?? config.translate?.model ?? "qwen2.5:7b";
  const baseURL = kwConfig.baseURL ?? config.embedding?.baseURL ?? "http://localhost:11434";

  const prompt = `You are a keyword extractor. Given a skill description, extract 3-5 short English trigger keywords (single words or simple phrases) that users would likely type to invoke this skill. Return ONLY a JSON array of strings, nothing else.

Skill name: ${skillName}
Description: ${description}

Respond with a JSON array, e.g.: ["git", "commit", "version control"]`;

  try {
    let text: string;
    if (provider === "ollama") {
      const resp = await fetch(`${baseURL.replace("/api/embeddings", "")}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      text = data.response?.trim() ?? "";
    } else if (provider === "minimax") {
      if (!minimaxApiKey) return [];
      const resp = await fetch("https://api.minimaxi.com/v1/text/chatcompletion_pro", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${minimaxApiKey}` },
        body: JSON.stringify({
          model: "abab6.5s-chat",
          messages: [
            { role: "system", content: "You are a keyword extractor. Return ONLY a JSON array of strings, nothing else." },
            { role: "user", content: prompt }
          ],
        }),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      text = data.choices?.[0]?.message?.content?.trim() ?? "";
    } else {
      if (!openaiApiKey) return [];
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiApiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a keyword extractor. Return ONLY a JSON array of strings, nothing else." },
            { role: "user", content: prompt }
          ],
        }),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      text = data.choices?.[0]?.message?.content?.trim() ?? "";
    }

    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .map(k => k.toLowerCase().trim());
  } catch {
    return [];
  }
}

async function loadSkillsFromDir(dirPath: string): Promise<SkillInfo[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const skills: SkillInfo[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dirPath, entry.name);
      const skillMdPath = join(skillPath, "SKILL.md");
      try {
        const content = await readFile(skillMdPath, "utf-8");
        const { name, description } = parseSkillMarkdown(content, entry.name);
        skills.push({ name, description, path: skillPath });
      } catch {
      }
    }
  } catch {
  }
  return skills;
}

async function getOrCacheSkills(
  api: OpenClawPluginApi,
  embeddingUrl: string,
  embeddingModel: string,
  config: SkillAutoInjectionConfig,
  minimaxApiKey: string,
  openaiApiKey: string
): Promise<CachedSkill[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const now = Date.now();
  if (cachedSkills.length > 0 && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedSkills;
  }

  const stateDir = api.config.stateDir ?? "/home/marlon-wei/.openclaw";
  const skillsDir = join(stateDir, "skills");
  const workspaceSkillsDir = join(stateDir, "..", "workspace", ".openclaw", "skills");

  const [globalSkills, workspaceSkills] = await Promise.all([
    loadSkillsFromDir(skillsDir),
    loadSkillsFromDir(workspaceSkillsDir),
  ]);

  const allSkills = [...globalSkills, ...workspaceSkills];
  const uniqueSkills = new Map<string, SkillInfo>();
  for (const skill of allSkills) {
    if (!uniqueSkills.has(skill.name)) {
      uniqueSkills.set(skill.name, skill);
    }
  }

  const cached: CachedSkill[] = [];
  for (const [, info] of uniqueSkills) {
    if (!info.description) continue;
    const [embedding, keywords] = await Promise.all([
      getEmbedding(info.description, embeddingUrl, embeddingModel),
      extractKeywordsFromDescription(info.description, info.name, config, minimaxApiKey, openaiApiKey),
    ]);
    if (embedding.length > 0) {
      cached.push({ info, embedding, keywords });
    }
  }

  cachedSkills = cached;
  lastCacheTime = now;
  api.logger.info?.(`[skill-auto-injection] loaded ${cached.length} skills with embeddings`);

  return cached;
}

const skillAutoInjectionPlugin = {
  id: "skill-auto-injection",
  name: "Skill Auto-Injection",
  description: "Auto-match user delivery task with available skills using embedding similarity",
  kind: "utility" as const,

  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);

    if (config.enabled === false) {
      api.logger.info?.("[skill-auto-injection] disabled by config");
      return;
    }

    const minimaxApiKey = process.env.MINIMAX_API_KEY ?? "";
    const openaiApiKey = process.env.OPENAI_API_KEY ?? "";

    const embeddingUrl = config.embedding?.baseURL
      ? `${config.embedding.baseURL}/api/embeddings`
      : "http://localhost:11434/api/embeddings";
    const embeddingModel = config.embedding?.model ?? "bge-m3";
    const threshold = config.matching?.skillMatchThreshold ?? 0.6;
    const maxSkills = config.matching?.maxSkills ?? 3;
    const translateEnabled = config.translate?.enabled ?? true;

    api.logger.info?.("[skill-auto-injection] register called");

    api.on("before_agent_start", async (event) => {
      const prompt = event.prompt;
      if (!prompt || prompt.length < 5) return;

      api.logger.info?.(`[skill-auto-injection] before_agent_start triggered, prompt length: ${prompt.length}, first 100 chars: "${prompt.slice(0, 100)}"`);

      try {
        const skills = await getOrCacheSkills(api, embeddingUrl, embeddingModel, config, minimaxApiKey, openaiApiKey);
        if (skills.length === 0) {
          api.logger.info?.(`[skill-auto-injection] no skills loaded, skipping`);
          return;
        }

        const L1Matched = skills.filter(s => keywordMatch(prompt, s.keywords));

        if (L1Matched.length > 0) {
          api.logger.info?.(`[skill-auto-injection] L1 keyword match hit: ${L1Matched.map(s => s.info.name).join(", ")}`);
          const topSkills = L1Matched.slice(0, maxSkills).map(s => ({
            name: s.info.name,
            description: s.info.description.slice(0, 200),
            score: 1.0,
          }));

          const skillsText = topSkills
            .map(s => `- [${s.name}]: ${s.description}`)
            .join("\n");

          return {
            prependContext: `[Skill Auto-Injection] The current conversation may involve these available skills:\n${skillsText}\n\nPlease consider using relevant skills to fulfill the user's request if applicable.`
          };
        }

        const skipTranslation = !translateEnabled || hasEnglishCharacters(prompt);
        let matchText = prompt;
        let wasTranslated = false;

        if (!skipTranslation) {
          const translated = await translateToEnglish(prompt, config, minimaxApiKey, openaiApiKey);
          if (translated && translated !== prompt) {
            api.logger.info?.(`[skill-auto-injection] translated: "${prompt.slice(0, 50)}..." -> "${translated.slice(0, 50)}..."`);
            matchText = translated;
            wasTranslated = true;
          } else {
            api.logger.info?.(`[skill-auto-injection] translation returned same text or failed, using original`);
          }
        } else {
          api.logger.info?.(`[skill-auto-injection] skipping translation (query has English or translation disabled)`);
        }

        const promptEmbedding = await getEmbedding(matchText, embeddingUrl, embeddingModel);
        if (promptEmbedding.length === 0) {
          api.logger.info?.(`[skill-auto-injection] failed to get embedding for prompt`);
          return;
        }

        const matchedSkills: Array<{ name: string; description: string; score: number; wasTranslated?: boolean }> = [];

        for (const skill of skills) {
          const score = cosineSimilarity(promptEmbedding, skill.embedding);
          api.logger.info?.(`[skill-auto-injection] score for ${skill.info.name}: ${(score * 100).toFixed(1)}%`);
          if (score >= threshold) {
            matchedSkills.push({
              name: skill.info.name,
              description: skill.info.description.slice(0, 200),
              score,
              wasTranslated,
            });
          }
        }

        if (matchedSkills.length === 0) return;

        matchedSkills.sort((a, b) => b.score - a.score);
        const topSkills = matchedSkills.slice(0, maxSkills);

        api.logger.info?.(`[skill-auto-injection] matched ${topSkills.length} skills (translated=${wasTranslated}): ${topSkills.map(s => `${s.name}(${(s.score * 100).toFixed(0)}%)`).join(", ")}`);

        const skillsText = topSkills
          .map(s => `- [${s.name}]: ${s.description}`)
          .join("\n");

        const translationNote = wasTranslated ? "\n(Note: User request was translated to English for matching.)" : "";

        return {
          prependContext: `[Skill Auto-Injection] The current conversation may involve these available skills:\n${skillsText}${translationNote}\n\nPlease consider using relevant skills to fulfill the user's request if applicable.`
        };

      } catch (err) {
        api.logger.warn?.(`[skill-auto-injection] matching failed: ${String(err)}`);
      }
    });
  },
};

export default skillAutoInjectionPlugin;

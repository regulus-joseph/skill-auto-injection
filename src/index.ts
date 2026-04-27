/**
 * skill-auto-injection/src/index.ts
 * ==================================
 * 更新: LLM 调用改用 llm-connector，env 引用 shared-lib
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  getEmbedding,
  translateToEnglish,
  extractKeywords,
  cosineSimilarity,
  type LLMConfig,
} from "../../../llm-connector/src/ts/connector.js";
import {
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
    provider?: "ollama";
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
  cfg: LLMConfig,
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
      getEmbedding(info.description, cfg),
      extractKeywords(info.description, info.name, cfg),
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

    const threshold = config.matching?.skillMatchThreshold ?? 0.6;
    const maxSkills = config.matching?.maxSkills ?? 3;
    const translateEnabled = config.translate?.enabled ?? true;

    const llmCfg: LLMConfig = {
      baseUrl:     config.embedding?.baseURL,
      embedModel:  config.embedding?.model,
      llmModel:    config.translate?.model,
    };

    api.logger.info?.("[skill-auto-injection] register called");

    api.on("before_agent_start", async (event) => {
      const prompt = event.prompt;
      if (!prompt || prompt.length < 5) return;

      try {
        const skills = await getOrCacheSkills(api, llmCfg);
        if (skills.length === 0) return;

        const L1Matched = skills.filter(s => {
          return s.keywords.some(kw =>
            prompt.toLowerCase().includes(kw.toLowerCase())
          );
        });

        if (L1Matched.length > 0) {
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
          const translated = await translateToEnglish(prompt, llmCfg);
          if (translated && translated !== prompt) {
            matchText = translated;
            wasTranslated = true;
          }
        }

        const promptEmbedding = await getEmbedding(matchText, llmCfg);
        if (promptEmbedding.length === 0) return;

        const matchedSkills: Array<{ name: string; description: string; score: number; wasTranslated?: boolean }> = [];
        for (const skill of skills) {
          const score = cosineSimilarity(promptEmbedding, skill.embedding);
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

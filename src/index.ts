/**
 * skill-auto-injection/src/index.ts
 * ==================================
 * L1: keyword extraction from prompt → match against skill.keywords (cheap, zero-cost)
 * L2: embedding similarity (only if L1 yields no results)
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  getEmbedding,
  translateToEnglish,
  extractKeywords,
  cosineSimilarity,
  type LLMConfig,
} from "../../llm-connector/src/ts/connector.ts";
import {
  hasEnglishCharacters,
  tokenizeForMatch,
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
    minKeywordMatch?: number;       // L1: min keyword hits to count as match (default 1)
    l2CandidateCount?: number;       // L2: max skills to consider for embedding fallback
  };
  keyword?: {
    enabled?: boolean;
    model?: string;
    baseURL?: string;
  };
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

interface SkillMeta {
  hash: string;
  computedAt: string;
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

async function simpleHash(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

async function loadSkillWithMeta(
  skillDir: string,
  cfg: LLMConfig,
  api: OpenClawPluginApi,
): Promise<CachedSkill | null> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const skillMdPath = join(skillDir, "SKILL.md");
  const metaPath = join(skillDir, "skill-meta.json");

  let content: string;
  try {
    content = await readFile(skillMdPath, "utf-8");
  } catch {
    return null;
  }

  const { name, description } = parseSkillMarkdown(content, skillDir.split("/").pop() ?? skillDir);
  if (!description) return null;

  const contentHash = await simpleHash(content);
  let meta: SkillMeta | null = null;
  let stale = true;

  try {
    const raw = await readFile(metaPath, "utf-8");
    meta = JSON.parse(raw) as SkillMeta;
    if (meta.hash === contentHash && meta.embedding?.length > 0) {
      stale = false;
    }
  } catch { /* no meta yet */ }

  if (stale) {
    api.logger.info?.(`[skill-auto-injection] computing embedding for ${name}...`);
    const [embedding, keywords] = await Promise.all([
      getEmbedding(description, cfg),
      extractKeywords(description, name, cfg),
    ]);
    if (embedding.length === 0) return null;
    meta = {
      hash: contentHash,
      computedAt: new Date().toISOString(),
      embedding,
      keywords,
    };
    try {
      await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
      api.logger.info?.(`[skill-auto-injection] cached embedding for ${name}`);
    } catch (err) {
      api.logger.warn?.(`[skill-auto-injection] failed to write meta for ${name}: ${String(err)}`);
    }
  } else {
    api.logger.info?.(`[skill-auto-injection] using cached embedding for ${name}`);
  }

  return { info: { name, description, path: skillDir }, embedding: meta.embedding, keywords: meta.keywords };
}

async function listSkillDirs(dirPath: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dirs: string[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(dirPath, entry.name));
    }
  } catch { /* no skills dir */ }
  return dirs;
}

async function getOrCacheSkills(
  api: OpenClawPluginApi,
  cfg: LLMConfig,
): Promise<CachedSkill[]> {
  const { join } = await import("node:path");

  const now = Date.now();
  if (cachedSkills.length > 0 && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedSkills;
  }

  const stateDir = api.config.stateDir ?? "/home/marlon-wei/.openclaw";
  const skillsDir = join(stateDir, "skills");
  const workspaceSkillsDir = join(stateDir, "..", "workspace", ".openclaw", "skills");

  const [globalDirs, workspaceDirs] = await Promise.all([
    listSkillDirs(skillsDir),
    listSkillDirs(workspaceSkillsDir),
  ]);

  const allDirs = [...globalDirs, ...workspaceDirs];
  const results = await Promise.all(
    allDirs.map(dir => loadSkillWithMeta(dir, cfg, api)),
  );

  const seen = new Map<string, CachedSkill>();
  for (const cs of results) {
    if (cs && !seen.has(cs.info.name)) {
      seen.set(cs.info.name, cs);
    }
  }

  cachedSkills = Array.from(seen.values());
  lastCacheTime = now;
  api.logger.info?.(`[skill-auto-injection] loaded ${cachedSkills.length} skills`);

  return cachedSkills;
}

const skillAutoInjectionPlugin = {
  id: "skill-auto-injection",
  name: "Skill Auto-Injection",
  description: "Auto-match user delivery task with available skills using keyword + embedding cascade",
  kind: "utility" as const,

  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);

    if (config.enabled === false) {
      api.logger.info?.("[skill-auto-injection] disabled by config");
      return;
    }

    const threshold = config.matching?.skillMatchThreshold ?? 0.6;
    const maxSkills = config.matching?.maxSkills ?? 3;
    const minKeywordHits = config.matching?.minKeywordMatch ?? 1;
    const l2CandidateCount = config.matching?.l2CandidateCount ?? 20;
    const translateEnabled = config.translate?.enabled ?? true;

    const llmCfg: LLMConfig = {
      baseUrl:    config.embedding?.baseURL,
      embedModel: config.embedding?.model,
      llmModel:   config.translate?.model,
    };

    api.logger.info?.("[skill-auto-injection] register called");

    api.on("before_prompt_build", async (params: { userMessage?: string }, _ctx) => {
      const prompt = params?.userMessage ?? "";
      if (!prompt || prompt.length < 5) return { prependContext: "" };

      try {
        const skills = await getOrCacheSkills(api, llmCfg);
        if (skills.length === 0) return { prependContext: "" };

        // ── L1: keyword matching ─────────────────────────────────────────
        // Extract English tokens from prompt, check how many hit each skill's keyword set
        const promptTokens = tokenizeForMatch(prompt);
        if (promptTokens.size > 0) {
          const scored: Array<{ skill: CachedSkill; hitCount: number; total: number }> = [];
          for (const skill of skills) {
            if (skill.keywords.length === 0) continue;
            const kwSet = new Set(skill.keywords.map(k => k.toLowerCase()));
            let hits = 0;
            for (const tok of promptTokens) {
              if (kwSet.has(tok)) hits++;
            }
            if (hits >= minKeywordHits) {
              scored.push({ skill, hitCount: hits, total: skill.keywords.length });
            }
          }

          if (scored.length > 0) {
            // Sort by hit ratio desc, then by hit count desc
            scored.sort((a, b) => {
              const ratioA = a.hitCount / a.total;
              const ratioB = b.hitCount / b.total;
              if (Math.abs(ratioA - ratioB) > 0.01) return ratioB - ratioA;
              return b.hitCount - a.hitCount;
            });

            const topSkills = scored.slice(0, maxSkills).map(({ skill, hitCount, total }) => ({
              name: skill.info.name,
              description: skill.info.description.slice(0, 200),
              score: hitCount / total,
              layer: "L1" as const,
            }));

            const skillsText = topSkills
              .map(s => `- [${s.name}]: ${s.description}`)
              .join("\n");

            return {
              prependContext: `[Skill Auto-Injection] The current conversation may involve these available skills:\n${skillsText}\n\nPlease consider using relevant skills to fulfill the user's request if applicable.`,
            };
          }
        }

        // ── L2: embedding cascade (only when L1 yields nothing) ───────
        if (skills.length === 0) return { prependContext: "" };

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
        if (promptEmbedding.length === 0) return { prependContext: "" };

        // Score all skills by cosine similarity, take top candidates
        const scored: Array<{ skill: CachedSkill; score: number }> = [];
        for (const skill of skills) {
          const score = cosineSimilarity(promptEmbedding, skill.embedding);
          if (score >= threshold) {
            scored.push({ skill, score });
          }
        }

        if (scored.length === 0) return { prependContext: "" };

        scored.sort((a, b) => b.score - a.score);
        const topSkills = scored.slice(0, l2CandidateCount).slice(0, maxSkills).map(({ skill, score }) => ({
          name: skill.info.name,
          description: skill.info.description.slice(0, 200),
          score,
          layer: "L2" as const,
          wasTranslated,
        }));

        const skillsText = topSkills
          .map(s => `- [${s.name}]: ${s.description}`)
          .join("\n");
        const translationNote = wasTranslated ? "\n(Note: User request was translated to English for matching.)" : "";

        return {
          prependContext: `[Skill Auto-Injection] The current conversation may involve these available skills:\n${skillsText}${translationNote}\n\nPlease consider using relevant skills to fulfill the user's request if applicable.`,
        };

      } catch (err) {
        api.logger.warn?.(`[skill-auto-injection] matching failed: ${String(err)}`);
        return { prependContext: "" };
      }
    });
  },
};

export default skillAutoInjectionPlugin;

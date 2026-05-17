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
} from "./llm-connector.ts";
import {
  hasEnglishCharacters,
  tokenizeForMatch,
  parseSkillMarkdown,
} from "./utils.js";

/**
 * Root configuration shape for the skill-auto-injection plugin.
 * Loaded from openclaw.json plugin config entry.
 */
interface SkillAutoInjectionConfig {
  /** Enable or disable the plugin entirely. */
  enabled?: boolean;
  /** Embedding model settings for L2 semantic matching. */
  embedding?: {
    /** Ollama API base URL (e.g. http://localhost:11434). */
    baseURL?: string;
    /** Embedding model name (e.g. bge-m3). */
    model?: string;
    /** Expected vector dimensions (informational). */
    dimensions?: number;
  };
  /** Translation settings for cross-language L2 matching. */
  translate?: {
    /** Enable translation of non-English prompts before embedding. */
    enabled?: boolean;
    /** Provider hint (currently only "ollama" is used). */
    provider?: "ollama";
    /** LLM model for translation (e.g. qwen2.5:7b). */
    model?: string;
  };
  /** Matching thresholds and limits. */
  matching?: {
    /** Minimum cosine similarity to inject a skill (L2, 0-1). Default: 0.6 */
    skillMatchThreshold?: number;
    /** Maximum number of skills to inject per prompt. Default: 3 */
    maxSkills?: number;
    /** Minimum keyword hits in L1 to count as a match. Default: 1 */
    minKeywordMatch?: number;
    /** Maximum candidates considered in L2 before top-N slice. Default: 20 */
    l2CandidateCount?: number;
  };
  /** LLM-based keyword extraction settings. */
  keyword?: {
    /** Enable L1 keyword matching. Default: true */
    enabled?: boolean;
    /** LLM model for extracting trigger keywords from skill descriptions. */
    model?: string;
    /** Override base URL for keyword extraction LLM. Defaults to embedding.baseURL. */
    baseURL?: string;
  };
}

/** Basic metadata for a discovered skill directory. */
interface SkillInfo {
  /** Display name from SKILL.md frontmatter. */
  name: string;
  /** Description extracted from SKILL.md frontmatter. */
  description: string;
  /** Absolute path to the skill directory. */
  path: string;
}

/**
 * A skill with its precomputed embedding and LLM-extracted keywords.
 * Held in the in-process LRU cache (5 min TTL).
 */
interface CachedSkill {
  /** Skill metadata (name, description, path). */
  info: SkillInfo;
  /** Precomputed embedding vector for the skill description. */
  embedding: number[];
  /** LLM-extracted trigger keywords for L1 matching. */
  keywords: string[];
}

/**
 * Persisted metadata for a skill, stored alongside SKILL.md as skill-meta.json.
 * Validated by content hash; recomputed when SKILL.md changes.
 */
interface SkillMeta {
  /** SHA-256 hash of SKILL.md content (first 24 hex chars). */
  hash: string;
  /** ISO-8601 timestamp when embedding was computed. */
  computedAt: string;
  /** The embedding vector. */
  embedding: number[];
  /** The extracted keywords array. */
  keywords: string[];
}

/** In-process LRU cache for loaded skills (5-minute TTL). */
let cachedSkills: CachedSkill[] = [];
/** Timestamp of last cache population (Date.now()). */
let lastCacheTime = 0;
/** Cache time-to-live in milliseconds (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Parse the raw plugin config value from openclaw.json.
 * Returns an empty object if the value is missing or malformed.
 */
function parsePluginConfig(value: unknown): SkillAutoInjectionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as SkillAutoInjectionConfig;
}

/**
 * Compute a short content hash for change detection.
 * Uses the first 24 characters (96 bits) of a SHA-256 hex digest.
 */
async function simpleHash(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

/**
 * Load a single skill directory: parse SKILL.md, check or compute embedding+keywords.
 *
 * If skill-meta.json exists and its hash matches the current SKILL.md content,
 * the cached embedding and keywords are used (disk cache hit).
 *
 * Otherwise, both embedding and keywords are computed in parallel via Ollama,
 * then persisted to skill-meta.json (cache miss → compute + write).
 *
 * Returns null if SKILL.md cannot be read or yields no description.
 */
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

/**
 * List all immediate subdirectories under dirPath.
 * Used to enumerate skill directories under ~/.openclaw/skills.
 */
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

/**
 * Get all loaded skills, using an in-process LRU cache (5-minute TTL).
 *
 * Scans both the global skills dir (~/.openclaw/skills) and the workspace
 * skills dir (~/.openclaw/workspace/.openclaw/skills) in parallel.
 * De-duplicates by skill name (global takes precedence).
 *
 * Each skill's embedding+keywords are loaded via loadSkillWithMeta, which
 * either hits the per-skill skill-meta.json disk cache or computes fresh.
 */
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

/**
 * Skill Auto-Injection plugin.
 *
 * Two-tier cascade:
 *  - L1 (keyword): Extract English tokens from the user prompt, check against each
 *    skill's pre-extracted keywords. Score = hit_count / total_keywords (hit ratio).
 *    Zero LLM cost. Only runs if prompt contains at least one English token.
 *  - L2 (embedding): Fallback semantic matching via cosine similarity of embeddings.
 *    Only triggered when L1 produces no matches.
 *
 * Injection: matched skill names + descriptions are prepended to the agent prompt
 * via the `prependContext` return value of the `before_prompt_build` hook.
 */
const skillAutoInjectionPlugin = {
  id: "skill-ai-inject",
  name: "Skill Auto-Injection",
  description: "Auto-match user delivery task with available skills using keyword + embedding cascade",
  kind: "utility" as const,

  /**
   * Register the plugin: parse config, then attach the before_prompt_build hook.
   */
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

    /**
     * before_prompt_build hook — entry point for skill matching.
     *
     * Flow:
     *  1. Load all skills (from LRU cache or disk+compute).
     *  2. L1: tokenise prompt → count keyword hits per skill.
     *     If any skill hits >= minKeywordHits, return top-N immediately (no L2).
     *  3. L2: translate prompt to English (if needed),
     *     compute embedding, rank all skills by cosine similarity,
     *     inject top-N skills above threshold.
     *
     * Returns `{ prependContext: string }` to inject matched skills into the prompt.
      * Returns `{ prependContext: "" }` when no skills match or on error (no-op).
      */
    api.registerHook("before_prompt_build", async (event: { prompt?: string }, _ctx) => {
      const prompt = event?.prompt ?? "";
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
              prependContext: `[Skill AI Inject] The current conversation may involve these available skills:\n${skillsText}\n\nPlease consider using relevant skills to fulfill the user's request if applicable.`,
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
          prependContext: `[Skill AI Inject] The current conversation may involve these available skills:\n${skillsText}${translationNote}\n\nPlease consider using relevant skills to fulfill the user's request if applicable.`,
        };

      } catch (err) {
        api.logger.warn?.(`[skill-ai-inject] matching failed: ${String(err)}`);
        return { prependContext: "" };
      }
    }, { name: "skill-ai-inject" });
  },
};

export default skillAutoInjectionPlugin;

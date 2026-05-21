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
  wordSimilarity,
  type LLMConfig,
} from "./llm-connector.ts";
import {
  hasEnglishCharacters,
  tokenizeForMatch,
  parseSkillMarkdown,
} from "./utils.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    /** Translate L1 prompt to English before matching (default: false) */
    translate?: boolean;
  };
  /** Task intent detection settings. */
  taskIntent?: {
    /** Custom task request patterns (e.g. ["帮我", "can you help"]). Merged with defaults. */
    patterns?: string[];
    /** Require all patterns to match (default: false — any pattern matches). */
    requireAll?: boolean;
    /** Case sensitive matching (default: false). */
    caseSensitive?: boolean;
    /** Minimum prompt length to check patterns (default: 5). */
    minLength?: number;
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
  /** Version of the meta schema (increment when extraction logic changes). */
  metaVersion: number;
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
const CURRENT_META_VERSION = 2;

/**
 * Session-level suppression: once skills are matched in a task conversation,
 * suppress re-matching until the prompt changes significantly or TTL expires.
 */
interface SessionState {
  matchedSkills: string[];   // skill names from last match
  timestamp: number;         // Date.now() when skills were matched
  lastPromptHash: string;   // hash of last prompt to detect change
}
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes suppression window
let sessionState: SessionState | null = null;

/**
 * Task intent patterns — pre-defined phrases indicating the user is requesting a task.
 * Only prompts matching one of these patterns will proceed to L1/L2 skill matching.
 * Pure string contains check — zero LLM cost.
 */
const TASK_PATTERNS = [
  // Chinese: common task request prefixes
  "帮我", "帮我做", "帮我分析", "帮我看看", "帮我查一下", "帮我找",
  "帮我写", "帮我改", "帮我优化", "帮我生成", "帮我创建", "帮我处理",
  "帮我翻译", "帮我解释", "帮我调试", "帮我修复", "帮我排查",
  "请帮我", "能否帮我", "可以帮我", "麻烦帮我", "帮我搞", "帮我弄",
  // Chinese: question-style task requests
  "怎么帮我", "能帮我", "需要帮我", "要帮我",
  // English: common task request patterns
  "can you help", "could you help", "please help", "help me",
  "i need you to", "i want you to", "i need help with",
  "would you mind", "i want to", "i need to",
  "could you please", "would you please", "can you please",
  "i would like you to", "could you also", "would you also",
  "please could you", "can you also",
  // English: direct commands with task intent
  "create a", "write a", "build a", "make a", "generate a",
  "analyze this", "check this", "review this", "fix this",
  "optimize this", "explain this", "help me with",
  "debug this", "test this", "run this", "execute this",
  "show me how", "tell me how", "how do i", "how can i",
  // English: question-style with intent
  "could you show", "can you show", "would you show",
  "could you give", "can you give", "would you give",
  "could you tell", "can you tell", "would you tell",
  // English: programming specific
  "帮我git", "帮我clone", "帮我install", "帮我build",
  "run git", "git commit", "git push", "git merge",
  "帮我debug", "帮我test", "帮我run", "帮我execute",
  "帮我deploy", "帮我install", "帮我compile",
  // Mixed: common programming commands
  "create file", "delete file", "move file", "copy file",
  "edit file", "read file", "write file", "open file",
];

function isTaskIntent(
  prompt: string,
  patterns: string[],
  options: { requireAll?: boolean; caseSensitive?: boolean }
): boolean {
  const getSearchTarget = (s: string) => options.caseSensitive ? s : s.toLowerCase();
  const target = getSearchTarget(prompt);

  const matches = patterns.map(p => {
    const pattern = options.caseSensitive ? p : p.toLowerCase();
    return target.includes(pattern);
  });

  return options.requireAll ? matches.every(Boolean) : matches.some(Boolean);
}

/**
 * Load task intent patterns from a config file.
 * Falls back to hardcoded TASK_PATTERNS if file is missing or invalid.
 * Supports # comments and empty lines.
 */
async function loadTaskIntentPatterns(stateDir: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const configPath = join(stateDir, "skill-auto-inject-patterns.txt");

  try {
    const content = await readFile(configPath, "utf-8");
    const patterns = content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("#"));
    if (patterns.length > 0) {
      return patterns;
    }
  } catch { /* file missing — fall back to defaults */ }

  return TASK_PATTERNS;
}

function loadTaskIntentPatternsSync(stateDir: string): string[] {
  const configPath = join(stateDir, "skill-auto-inject-patterns.txt");

  try {
    const content = readFileSync(configPath, "utf-8");
    const filePatterns = content
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith("#"));

    // Merge file patterns with defaults, deduplicated
    const allPatterns = [...new Set([...TASK_PATTERNS, ...filePatterns])];
    return allPatterns;
  } catch { /* file missing — use defaults only */ }

  return TASK_PATTERNS;
}

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
    const versionOk = (meta.metaVersion ?? 0) >= CURRENT_META_VERSION;
    if (versionOk && meta.hash === contentHash && meta.embedding?.length > 0) {
      stale = false;
    } else {
      stale = true;
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
      metaVersion: CURRENT_META_VERSION,
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

    const threshold = config.matching?.skillMatchThreshold ?? 0.5;
    const maxSkills = config.matching?.maxSkills ?? 3;
    const minKeywordHits = config.matching?.minKeywordMatch ?? 1;
    const l2CandidateCount = config.matching?.l2CandidateCount ?? 20;
    const translateEnabled = config.translate?.enabled ?? false;

    const llmCfg: LLMConfig = {
      baseUrl:    config.embedding?.baseURL,
      embedModel: config.embedding?.model,
      llmModel:   config.keyword?.model,
    };

    const keywordTranslate = config.keyword?.translate ?? false;
    const l1ScoreThreshold = 0.3; // fuzzy match threshold for L1

    // Load task intent patterns from config file, fall back to hardcoded defaults
    const stateDir = api.config.stateDir ?? "/home/marlon-wei/.openclaw";
    let taskIntentPatterns: string[] = TASK_PATTERNS;

    // Load task intent options from config
    const taskIntentRequireAll = config.taskIntent?.requireAll ?? false;
    const taskIntentCaseSensitive = config.taskIntent?.caseSensitive ?? false;
    const taskIntentMinLength = config.taskIntent?.minLength ?? 5;

    api.logger.info?.("[skill-auto-injection] register called");

    // Load patterns synchronously on startup
    taskIntentPatterns = loadTaskIntentPatternsSync(stateDir);
    api.logger.info?.(`[skill-auto-injection] loaded ${taskIntentPatterns.length} task intent patterns`);

    /**
     * before_prompt_build hook — entry point for skill matching.
     *
     * Flow:
     *  1. Session suppression: skip if recently matched and prompt unchanged.
     *  2. Task intent gate: skip if prompt doesn't match known task request patterns.
     *  3. Load all skills (from LRU cache or disk+compute).
     *  4. L1: tokenise prompt → count keyword hits per skill.
     *     If any skill hits >= minKeywordHits, return top-N immediately (no L2).
     *  5. L2: translate prompt to English (if needed),
     *     compute embedding, rank all skills by cosine similarity,
     *     inject top-N skills above threshold.
     *
     * Returns `{ prependContext: string }` to inject matched skills into the prompt.
      * Returns `{ prependContext: "" }` when no skills match or on error (no-op).
      */
    api.on("before_prompt_build", async (event: { prompt?: string }, _ctx) => {
      const prompt = event?.prompt ?? "";
      if (!prompt || prompt.length < 5) return { prependContext: "" };

      // Quick hash for session detection (first 64 chars as proxy for content)
      const promptHash = prompt.slice(0, 64);

      // Session suppression: if skills were matched recently and prompt hasn't changed much, skip
      if (sessionState && Date.now() - sessionState.timestamp < SESSION_TTL_MS) {
        // If prompt is very short and different from last, still allow (new task signal)
        // If prompt is similar to last, suppress
        if (prompt.length < 20 && sessionState.lastPromptHash === promptHash) {
          return { prependContext: "" };
        }
        // If prompt is long but contains same key content, suppress
        if (prompt.includes(sessionState.lastPromptHash.slice(0, 32))) {
          return { prependContext: "" };
        }
      }

      // Task intent gate: only proceed if prompt matches a known task request pattern
      if (prompt.length >= taskIntentMinLength && !isTaskIntent(prompt, taskIntentPatterns, { requireAll: taskIntentRequireAll, caseSensitive: taskIntentCaseSensitive })) {
        api.logger.info?.(`[skill-ai-inject] task intent gate skipped — prompt: "${prompt}"`);
        return { prependContext: "" };
      }

      api.logger.info?.(`[skill-ai-inject] task intent matched — proceeding to L1/L2`);

      try {
        const skills = await getOrCacheSkills(api, llmCfg);
        if (skills.length === 0) return { prependContext: "" };

        // ── L1: keyword matching ─────────────────────────────────────────
        // Tokenize: English via regex, Chinese via jieba + POS weighting
        const LOW_WEIGHT = 0.01;
        const HIGH_WEIGHT = 1.0;
        const EN_STOPWORDS = new Set([
          "the","a","an","is","are","was","were","to","of","in","for","on","at","by",
          "can","could","would","should","do","does","did","have","has","had",
          "this","that","these","those","i","you","he","she","it","we","they",
          "me","him","her","us","them","my","your","his","its","our","their",
          "what","which","who","when","where","how","please","help","can","you",
          "and","or","but","if","then","so","be","been","being","not","no","yes",
        ]);
        const POS_WEIGHTS: Record<string, number> = {
          n: HIGH_WEIGHT,   // 名词
          eng: HIGH_WEIGHT, // 英文词
          l: HIGH_WEIGHT,   // 习用语
          nz: HIGH_WEIGHT,  // 其他名词/音译名
          nt: HIGH_WEIGHT,  // 地名/机构名
          v: LOW_WEIGHT,    // 动词
          f: LOW_WEIGHT,    // 方位词
          c: LOW_WEIGHT,    // 连词
          r: LOW_WEIGHT,    // 代词
          uj: LOW_WEIGHT,   // 助词
          x: 0,             // 字符串，忽略
        };

        let l1Prompt = prompt;
        if (keywordTranslate && !hasEnglishCharacters(prompt)) {
          try {
            l1Prompt = await translateToEnglish(prompt, llmCfg);
          } catch { /* skip translation */ }
        }

        // English tokens (from regex)
        const englishTokens = tokenizeForMatch(l1Prompt);

        // Chinese tokens via jieba POS tagger
        const { default: jieba } = await import("nodejieba");
        const tagged = jieba.tag(l1Prompt);
        const chineseTokens: Array<{ token: string; weight: number }> = [];
        for (const { word, tag } of tagged) {
          if (word.length < 2 || /[a-zA-Z]/.test(word)) continue;
          if (tag === "x") continue;
          const w = POS_WEIGHTS[tag] ?? LOW_WEIGHT;
          chineseTokens.push({ token: word, weight: w });
        }

        if (englishTokens.size === 0 && chineseTokens.length === 0) {
          api.logger.info?.(`[skill-ai-inject] L1: no tokens extracted — skip`);
        } else {
          const scored: Array<{ skill: CachedSkill; score: number; detail: string }> = [];
          for (const skill of skills) {
            if (skill.keywords.length === 0) continue;
            const kws = skill.keywords.map(k => k.toLowerCase());
            let weightedScore = 0;
            let totalWeight = 0;

            // English tokens (stopword-filtered, similarity-weighted)
            for (const tok of englishTokens) {
              let best = 0;
              for (const kw of kws) {
                const sim = wordSimilarity(tok, kw);
                if (sim > best) best = sim;
              }
              const weight = EN_STOPWORDS.has(tok) ? LOW_WEIGHT : (best > 0 ? HIGH_WEIGHT : LOW_WEIGHT);
              weightedScore += best * weight;
              totalWeight += weight;
            }

            // Chinese tokens (POS-based weight)
            for (const { token, weight } of chineseTokens) {
              let best = 0;
              for (const kw of kws) {
                const sim = wordSimilarity(token, kw);
                if (sim > best) best = sim;
              }
              weightedScore += best * weight;
              totalWeight += weight;
            }

            const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
            // Build detail string for logging
            const enHits = [...englishTokens].filter(tok => kws.some(kw => wordSimilarity(tok, kw) > 0.5)).join(",");
            const zhHits = chineseTokens.filter(({ token }) => kws.some(kw => wordSimilarity(token, kw) > 0.5)).map(t => t.token).join(",");
            const detail = `en=[${enHits}] zh=[${zhHits}]`;
            scored.push({ skill, score: avgScore, detail });
          }

          // Log all candidates with scores
          const allScores = scored.map(({ skill, score, detail }) => `${skill.info.name}:${score.toFixed(3)}[${detail}]`).join(", ");
          api.logger.info?.(`[skill-ai-inject] L1 candidates (threshold=${l1ScoreThreshold}): ${allScores}`);

          const passed = scored.filter(({ score }) => score >= l1ScoreThreshold);
          if (passed.length > 0) {
            passed.sort((a, b) => b.score - a.score);

            const topSkills = passed.slice(0, maxSkills).map(({ skill, score, detail }) => ({
              name: skill.info.name,
              description: skill.info.description.slice(0, 200),
              score,
              detail,
              layer: "L1" as const,
            }));

            const skillsText = topSkills
              .map(s => `- [${s.name}] score=${s.score.toFixed(3)} ${s.detail}: ${s.description}`)
              .join("\n");

            // Update session state on successful match
            sessionState = {
              matchedSkills: topSkills.map(s => s.name),
              timestamp: Date.now(),
              lastPromptHash: promptHash,
            };

            api.logger.info?.(`[skill-ai-inject] L1 injecting ${topSkills.length}/${passed.length} skills: ${topSkills.map(s => `${s.name}(${s.score.toFixed(3)})`).join(", ")}`);

            return {
              prependContext: `[Skill AI Inject] The current conversation may involve these available skills:\n${skillsText}\n\nPlease consider using relevant skills to fulfill the user's request if applicable.`,
            };
          }
        }

        // ── L2: embedding cascade (only when L1 yields nothing) ───────
        api.logger.info?.(`[skill-ai-inject] L1 missed — proceeding to L2 embedding`);
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
        // Log top scores even if below threshold
        const allL2Scores: string[] = [];
        for (const skill of skills) {
          const score = cosineSimilarity(promptEmbedding, skill.embedding);
          if (score >= threshold) {
            scored.push({ skill, score });
          }
          allL2Scores.push(`${skill.info.name}:${score.toFixed(3)}`);
        }
        api.logger.info?.(`[skill-ai-inject] L2 all scores (threshold=${threshold}): ${allL2Scores.join(", ")}`);

        if (scored.length === 0) {
          const topScores = skills.slice(0, 5).map(s => {
            const score = cosineSimilarity(promptEmbedding, s.embedding);
            return `${s.info.name}:${score.toFixed(3)}`;
          }).join(', ');
          api.logger.info?.(`[skill-ai-inject] L2 scores all below threshold ${threshold} — top: ${topScores}`);
          return { prependContext: "" };
        }

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

        // Update session state on successful L2 match
        sessionState = {
          matchedSkills: topSkills.map(s => s.name),
          timestamp: Date.now(),
          lastPromptHash: promptHash,
        };

        api.logger.info?.(`[skill-ai-inject] L2 injecting ${topSkills.length}/${scored.length} skills: ${topSkills.map(s => `${s.name}(${s.score.toFixed(3)})`).join(", ")}`);

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

/**
 * Translation effectiveness test for skill-auto-injection L2 matching.
 *
 * Compares L2 embedding match scores WITH and WITHOUT translation,
 * using real Ollama calls to measure translation impact.
 *
 * Usage: npx tsx tests/translation-effectiveness-test.ts
 */
import { getEmbedding, translateToEnglish, cosineSimilarity } from "../src/llm-connector.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseSkillMarkdown } from "../src/utils.js";

const OLLAMA_URL = "http://localhost:11434";
const EMBED_MODEL = "bge-m3:latest";
const TRANSLATE_MODEL = "qwen3.5:4b";

// Test queries - mix of Chinese, English, and mixed
const TEST_QUERIES = [
  "帮我git提交代码",
  "用git创建分支并合并",
  "帮我分析这个代码库",
  "我想了解浏览器的操作",
  "git merge conflict 怎么处理",
  "帮我改一下这个网页",
  "做代码审查",
  "运行测试用例",
];

interface SkillScore {
  name: string;
  description: string;
  rawScore: number | null;
  translatedScore: number | null;
  rawRank: number;
  translatedRank: number;
}

async function loadSkillsFromDir(dirPath: string) {
  const { readFile } = await import("node:fs/promises");
  const skills: { name: string; description: string; embedding: number[] }[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dirPath, entry.name);
      try {
        const content = await readFile(join(skillDir, "SKILL.md"), "utf-8");
        const { name, description } = parseSkillMarkdown(content, entry.name);
        if (!description) continue;

        const embedding = await getEmbedding(description, {
          baseUrl: OLLAMA_URL,
          embedModel: EMBED_MODEL,
        });
        if (embedding.length > 0) {
          skills.push({ name, description, embedding });
        }
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }

  return skills;
}

async function main() {
  console.log("=== Translation Effectiveness Test ===\n");
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`Embed model: ${EMBED_MODEL}`);
  console.log(`Translate model: ${TRANSLATE_MODEL}\n`);

  const skillsDir = "/home/marlon-wei/.openclaw/skills";
  const skills = await loadSkillsFromDir(skillsDir);

  if (skills.length === 0) {
    console.log("No skills found. Check ~/.openclaw/skills/ directory.");
    return;
  }

  console.log(`Loaded ${skills.length} skills\n`);
  console.log("Skills:");
  for (const s of skills) {
    console.log(`  - ${s.name}: ${s.description.slice(0, 80)}...`);
  }
  console.log("\n" + "=".repeat(80) + "\n");

  interface Result {
    query: string;
    hasEnglish: boolean;
    translation: string | null;
    topRaw: string[];
    topTranslated: string[];
    changed: boolean;
    scores: SkillScore[];
  }

  const results: Result[] = [];

  for (const query of TEST_QUERIES) {
    const hasEnglish = /[a-zA-Z]{2,}/.test(query);

    let translation: string | null = null;
    if (!hasEnglish) {
      translation = await translateToEnglish(query, {
        baseUrl: OLLAMA_URL,
        llmModel: TRANSLATE_MODEL,
      });
    }

    const rawEmbedding = await getEmbedding(query, {
      baseUrl: OLLAMA_URL,
      embedModel: EMBED_MODEL,
    });

    let translatedEmbedding: number[] | null = null;
    if (translation) {
      translatedEmbedding = await getEmbedding(translation, {
        baseUrl: OLLAMA_URL,
        embedModel: EMBED_MODEL,
      });
    }

    const scores: SkillScore[] = skills.map(skill => {
      const rawScore = rawEmbedding.length > 0
        ? cosineSimilarity(rawEmbedding, skill.embedding)
        : null;
      const translatedScore = translatedEmbedding && translatedEmbedding.length > 0
        ? cosineSimilarity(translatedEmbedding, skill.embedding)
        : null;

      return {
        name: skill.name,
        description: skill.description.slice(0, 80),
        rawScore,
        translatedScore,
        rawRank: 0,
        translatedRank: 0,
      };
    });

    // Sort by raw score and rank
    scores.filter(s => s.rawScore !== null).sort((a, b) => b.rawScore! - a.rawScore!);
    scores.forEach((s, i) => { s.rawRank = i + 1; });

    // Sort by translated score and rank
    if (translatedEmbedding) {
      scores.filter(s => s.translatedScore !== null).sort((a, b) => b.translatedScore! - a.translatedScore!);
      scores.forEach((s, i) => { s.translatedRank = i + 1; });
    }

    const topRaw = scores.slice(0, 3).map(s => s.name);
    const topTranslated = translatedEmbedding
      ? scores.slice(0, 3).map(s => s.name)
      : [];
    const changed = translation
      ? JSON.stringify(topRaw) !== JSON.stringify(topTranslated)
      : false;

    results.push({
      query,
      hasEnglish,
      translation,
      topRaw,
      topTranslated,
      changed,
      scores,
    });

    // Print query result
    console.log(`Query: "${query}"`);
    console.log(`  Has English: ${hasEnglish}`);
    if (translation) {
      console.log(`  Translation: "${translation}"`);
    }
    console.log("\n  RAW (no translation):");
    scores.slice(0, 5).forEach((s, i) => {
      console.log(`    ${i + 1}. ${s.name} (score: ${s.rawScore?.toFixed(4) ?? "N/A"})`);
    });

    if (translatedEmbedding) {
      console.log("\n  TRANSLATED:");
      scores.slice(0, 5).forEach((s, i) => {
        console.log(`    ${i + 1}. ${s.name} (score: ${s.translatedScore?.toFixed(4) ?? "N/A"})`);
      });
    }

    console.log(`\n  Top-3 RAW:      [${topRaw.join(", ")}]`);
    if (translation) {
      console.log(`  Top-3 TRANSLATED: [${topTranslated.join(", ")}]`);
    }
    console.log(`  Changed: ${changed ? "YES" : "NO"}`);
    console.log("-".repeat(80) + "\n");
  }

  // Summary
  console.log("\n=== SUMMARY ===\n");
  const changedCount = results.filter(r => r.changed).length;
  const translatedCount = results.filter(r => r.translation !== null).length;

  console.log(`Total queries: ${results.length}`);
  console.log(`Queries translated: ${translatedCount}`);
  console.log(`Top-3 results changed: ${changedCount}`);

  console.log("\nQueries where translation HELPED (translated entered top-3):");
  for (const r of results) {
    if (r.translation) {
      const addedByTranslation = r.topTranslated.filter(n => !r.topRaw.includes(n));
      if (addedByTranslation.length > 0) {
        console.log(`  "${r.query}" -> added: [${addedByTranslation.join(", ")}]`);
      }
    }
  }

  console.log("\nQueries where translation HURT (raw was better):");
  for (const r of results) {
    if (r.translation) {
      const removedByTranslation = r.topRaw.filter(n => !r.topTranslated.includes(n));
      if (removedByTranslation.length > 0) {
        console.log(`  "${r.query}" -> removed: [${removedByTranslation.join(", ")}]`);
      }
    }
  }
}

main().catch(console.error);
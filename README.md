# Skill Auto-Injection Plugin

> Automatically match user delivery tasks with available skills using embedding similarity

## Version

**v0.4.0** · OpenClaw 2026.5.x compatible

---

## Overview

skill-auto-injection automatically matches user input against available skills (from local SKILL.md files) and injects the top matches into the agent's prompt context. It uses a two-tier cascade: L1 keyword match (zero cost, instant) → L2 embedding fallback (semantic, cross-language).

**Key features**:
- L1 keyword match with LLM-extracted trigger keywords (no manual whitelist maintenance)
- L2 embedding fallback for semantic matching across languages
- Smart translation: skips translation when query already contains English characters
- Ollama-only: no external API keys required

---

## Prerequisites

### Ollama models

```bash
ollama pull bge-m3          # for embedding similarity
ollama pull qwen2.5:7b      # for translation and keyword extraction
```

---

## Installation

### 1. Build plugin

```bash
cd ~/projects/skill-auto-injection
npm install
npm run build
```

### 2. Link plugin to OpenClaw

```bash
openclaw plugins install --link .
```

### 3. Configure openclaw.json

```json
{
  "plugins": {
    "allow": ["memory-recall", "skill-auto-injection", "policy-layer", "minimax", "browser"],
    "bundledDiscovery": "allowlist",
    "entries": {
      "skill-auto-injection": {
        "enabled": true,
        "config": {
          "embedding": {
            "baseURL": "http://localhost:11434",
            "model": "bge-m3",
            "dimensions": 1024
          },
          "translate": {
            "enabled": true,
            "model": "qwen2.5:7b"
          },
          "matching": {
            "skillMatchThreshold": 0.6,
            "maxSkills": 3,
            "minKeywordMatch": 1,
            "l2CandidateCount": 20
          },
          "keyword": {
            "enabled": true,
            "model": "qwen2.5:7b"
          }
        }
      }
    }
  }
}
```

### 4. Restart gateway

```bash
openclaw gateway restart
```

### 5. Verify

```bash
openclaw plugins inspect skill-auto-injection
# Should show: Status: loaded
```

---

## Configuration

### Config Parameters

| Config | Description | Default |
|--------|-------------|---------|
| `enabled` | Enable plugin | `true` |
| `embedding.baseURL` | Embedding API URL | `http://localhost:11434` |
| `embedding.model` | Embedding model | `bge-m3` |
| `embedding.dimensions` | Vector dimensions | `1024` |
| `translate.enabled` | Enable translation | `true` |
| `translate.model` | Translation model | `qwen2.5:7b` |
| `matching.skillMatchThreshold` | Skill match threshold (0-1) | `0.6` |
| `matching.maxSkills` | Max skills to inject | `3` |
| `matching.minKeywordMatch` | Min keyword hits for L1 match | `1` |
| `matching.l2CandidateCount` | Max candidates for L2 embedding stage | `20` |
| `keyword.enabled` | Enable L1 keyword matching | `true` |
| `keyword.model` | LLM model for keyword extraction | `qwen2.5:7b` |
| `keyword.baseURL` | Override baseURL for keyword LLM | `null` (uses embedding.baseURL) |

**Note**: All LLM operations use Ollama locally — no external API keys required.

---

## OpenClaw Configuration Notes

### Plugin ID Mismatch

**Problem**: `plugin id mismatch (config uses "skill-ai-inject", export uses "skill-auto-injection")`

**Solution**: The plugin ID must match exactly between `openclaw.plugin.json` and the exported JavaScript object. Always use `skill-auto-injection` as the canonical ID (matching the GitHub repo name). Update `openclaw.json` entries accordingly:

```json
"entries": {
  "skill-auto-injection": { ... }
}
```

### bundledDiscovery: "allowlist"

When `bundledDiscovery` is set to `"allowlist"` (default), the `plugins.allow` list filters ALL plugins. Make sure `skill-auto-injection` is listed:

```json
"plugins": {
  "allow": ["skill-auto-injection", ...]
}
```

### policy-layer AllowPromptInjection

If policy-layer blocks prompt injection, skill matching results won't appear in context:

```json
"entries": {
  "policy-layer": {
    "enabled": true,
    "config": {
      "hooks": {
        "allowPromptInjection": true
      }
    }
  }
}
```

---

## Workflow

```
User Message → before_prompt_build hook
  │
  ├── L1: Keyword Match (zero cost)
  │     Extract English tokens from prompt
  │     Match against skill trigger keywords (hit ratio scoring)
  │     → HIT → Inject matched skills immediately
  │
  └── L2: Embedding Fallback (only if L1 misses)
        Query has English chars? → Skip translation
        Otherwise → Translate to English
        Get embedding → Cosine similarity → Filter by threshold
        → Inject top-N matched skills
```

**Keywords are extracted by LLM when skills are loaded** (cached for 5 min) — no manual maintenance required.

---

## Skills Source

Plugin scans SKILL.md from:
1. `~/.openclaw/skills/` — Global skills
2. `~/.openclaw/workspace/.openclaw/skills/` — Workspace skills

**Note**: Currently only scans local directories. OpenClaw bundled skills (acp-router, coding-agent, etc.) are not included.

---

## Injection Format

When skills are matched, prepends:

```
[Skill Auto-Injection] The current conversation may involve these available skills:
- [skill-name]: skill description...

Please consider using relevant skills to fulfill the user's request if applicable.
```

---

## Debugging

```bash
# View plugin logs
openclaw logs 2>&1 | grep skill-auto-injection

# Check plugin status
openclaw plugins inspect skill-auto-injection

# List available skills
openclaw skills list

# Restart gateway
openclaw gateway restart
```

---

## Known Issues

- Only scans local skill directories; bundled OpenClaw skills are not included
- No exclusion list for specific skills
- No user feedback loop for learning from corrections

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-22 | Initial: embedding-based skill matching |
| 0.2.0 | 2026-04-22 | Add multi-provider translation (ollama/minimax/openai), optimize logging |
| 0.3.0 | 2026-04-25 | L1 keyword match (zero-cost) + L2 embed cascade; LLM keyword extraction on skill load; skip translation for English queries |
| **0.4.0** | 2026-05-10 | **Reverse L1 matching direction; switch to `before_prompt_build` hook; hit-ratio scoring; l2CandidateCount config** |
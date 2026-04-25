# Skill Auto-Injection Plugin

> Automatically match user delivery tasks with available skills using embedding similarity

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-22 | Initial version: embedding-based skill matching |
| 0.2.0 | 2026-04-22 | Add multi-provider translation (ollama/minimax/openai), optimize logging |
| 0.3.0 | 2026-04-25 | L1 keyword match (zero-cost) + L2 embed cascade; LLM keyword extraction on skill load; skip translation for English queries |

## Features

- **Two-Tier Matching**: L1 keyword match (instant, zero LLM cost) + L2 embedding fallback (semantic, cross-language)
- **LLM Keyword Extraction**: On skill load, extract 3-5 trigger keywords via LLM — no manual whitelist maintenance
- **Smart Translation**: Skip translation when query already contains English characters
- **Skill Matching**: Match user input against skill descriptions using embedding models
- **Multi-Provider Translation**: Support Ollama, MiniMax, OpenAI translation providers
- **Context Injection**: Auto-inject matched skills via `before_agent_start` hook
- **Caching**: Cache skill embeddings and keywords for 5 minutes to avoid repeated computation

## Project Structure

```
skill-auto-injection/
├── openclaw.plugin.json    # Plugin configuration
├── package.json          # Node.js package config
├── vitest.config.ts     # Test configuration
├── src/
│   ├── index.ts          # Plugin entry point
│   └── utils.ts          # Pure utility functions
├── tests/
│   └── utils.test.ts     # Unit tests (34 passing)
└── README.md
```

## Installation

```bash
cd ~/projects/skill-auto-injection
npm install
openclaw plugins install --link .
openclaw gateway restart
```

## Configuration

### Plugin Config (openclaw.json)

```json
{
  "plugins": {
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
            "provider": "ollama",
            "model": "qwen2.5:7b"
          },
          "matching": {
            "skillMatchThreshold": 0.6,
            "maxSkills": 3
          },
          "keyword": {
            "enabled": true,
            "model": "qwen2.5:7b",
            "baseURL": null
          }
        }
      }
    }
  }
}
```

### Config Parameters

| Config | Description | Default |
|--------|-------------|---------|
| `enabled` | Enable plugin | `true` |
| `embedding.baseURL` | Embedding API URL | `http://localhost:11434` |
| `embedding.model` | Embedding model | `bge-m3` |
| `embedding.dimensions` | Vector dimensions | `1024` |
| `translate.enabled` | Enable translation | `true` |
| `translate.provider` | Translation provider | `ollama` |
| `translate.model` | Translation model | `qwen2.5:7b` |
| `matching.skillMatchThreshold` | Skill match threshold (0-1) | `0.6` |
| `matching.maxSkills` | Max skills to inject | `3` |
| `keyword.enabled` | Enable L1 keyword matching | `true` |
| `keyword.model` | LLM model for keyword extraction | `qwen2.5:7b` |
| `keyword.baseURL` | Override baseURL for keyword LLM | `null` (uses embedding.baseURL) |

### Translation Provider Config

| Provider | Env Variable | Notes |
|----------|-------------|-------|
| `ollama` | None required | Use local Ollama |
| `minimax` | `MINIMAX_API_KEY` | Use MiniMax API |
| `openai` | `OPENAI_API_KEY` | Use OpenAI API |

## Workflow

```
User Message → before_agent_start hook
  │
  ├── L1: Keyword Match (zero cost)
  │     Extract English tokens from query
  │     Check against skill trigger keywords
  │     → HIT → Inject matched skills immediately
  │
  └── L2: Embedding Fallback (only if L1 misses)
        Query has English chars? → Skip translation
        Otherwise → Translate to English
        Get embedding → Cosine similarity → Filter by threshold
        → Inject top-N matched skills
```

**Keywords are extracted by LLM when skills are loaded** (cached for 5 min) — no manual maintenance required.

## Skills Source

Plugin scans SKILL.md from:
1. `~/.openclaw/skills/` - Global skills
2. `~/.openclaw/workspace/.openclaw/skills/` - Workspace skills

**Note**: Currently only scans local directories. OpenClaw bundled skills (acp-router, coding-agent, etc.) are not included.

## Injection Format

When skills are matched, prepends:

```
[Skill Auto-Injection] The current conversation may involve these available skills:
- [skill-name]: skill description...

Please consider using relevant skills to fulfill the user's request if applicable.
```

## Testing

```bash
npm test          # Run all tests
npm run test:watch  # Watch mode
```

**34 unit tests** covering keyword matching, tokenization, cosine similarity, markdown parsing, and L1/L2 cascade logic.

## Debugging

```bash
# View plugin logs
openclaw logs 2>&1 | grep skill-auto-injection

# List skills
openclaw skills list

# Restart gateway
openclaw gateway restart
```

## Future Improvements

1. **Bundled Skills Support**: Scan OpenClaw builtin skills directory
2. **Exclusion List**: Exclude specific skills from auto-matching
3. **User Feedback Loop**: Learn from user corrections (skill was/wasn't helpful)
4. **Skill Auto-Install**: Auto-install from ClawHub when high-confidence match but skill not installed

## References

- [OpenClaw Plugin SDK](https://github.com/openclaw/openclaw)
- [bge-m3 embedding](https://ollama.com/)

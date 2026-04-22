# Skill Auto-Injection Plugin

> Automatically match user delivery tasks with available skills using embedding similarity

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-22 | Initial version: embedding-based skill matching |
| 0.2.0 | 2026-04-22 | Add multi-provider translation (ollama/minimax/openai), optimize logging |

## Features

- **Delivery Task Detection**: Detect if user input is a delivery task via embedding similarity
- **Skill Matching**: Match user input against skill descriptions using embedding models
- **Auto-Translation**: Translate non-English input to English for cross-language matching
- **Multi-Provider Translation**: Support Ollama, MiniMax, OpenAI translation providers
- **Context Injection**: Auto-inject matched skills via `before_agent_start` hook
- **Caching**: Cache skill embeddings for 5 minutes to avoid repeated computation

## Project Structure

```
skill-auto-injection/
├── openclaw.plugin.json    # Plugin configuration
├── package.json          # Node.js package config
├── src/
│   └── index.ts          # Plugin entry point
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

### Translation Provider Config

| Provider | Env Variable | Notes |
|----------|-------------|-------|
| `ollama` | None required | Use local Ollama |
| `minimax` | `MINIMAX_API_KEY` | Use MiniMax API |
| `openai` | `OPENAI_API_KEY` | Use OpenAI API |

## Workflow

```
User Message → before_agent_start hook →
  (optional) Translate to English →
  Get embedding →
  Match against all skills →
  Filter by threshold →
  Inject into prependContext
```

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
2. **Delivery Task Detection**: Dedicated delivery pattern detection (not just embedding)
3. **Whitelist Management**: Configurable skill whitelist
4. **Exclusion List**: Exclude specific skills from auto-matching
5. **Real-time Translation**: Use faster translation for lower latency

## References

- [OpenClaw Plugin SDK](https://github.com/openclaw/openclaw)
- [memory-recall plugin](../memory-recall)
- [bge-m3 embedding](https://ollama.com/)
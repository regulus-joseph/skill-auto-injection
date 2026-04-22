# Skill Auto-Injection Plugin

> Automatically match user delivery task with available skills using embedding similarity

## 版本历史

| 版本 | 日期 | 更新内容 |
|-----|------|---------|
| 0.1.0 | 2026-04-22 | 初始版本: 基于embedding的skill匹配 |
| 0.2.0 | 2026-04-22 | 添加多provider翻译支持(ollama/minimax/openai),优化日志 |

## 功能特性

- **交付任务检测**: 通过embedding相似度检测用户输入是否为交付任务
- **Skill匹配**: 使用embedding模型将用户输入与skill描述进行匹配
- **自动翻译**: 支持将非英文用户输入翻译成英文后匹配(解决跨语言问题)
- **多Provider翻译**: 支持Ollama、MiniMax、OpenAI等多种翻译provider
- **上下文注入**: 通过 `before_agent_start` hook自动将匹配的skills注入到上下文
- **缓存优化**: Skills embedding结果缓存5分钟,避免重复计算

## 项目结构

```
skill-auto-injection/
├── openclaw.plugin.json    # 插件配置
├── package.json            # Node.js包配置
├── src/
│   └── index.ts          # 插件入口
└── README.md
```

## 安装

```bash
cd ~/projects/skill-auto-injection
npm install
openclaw plugins install --link .
openclaw gateway restart
```

## 配置

### 插件配置 (openclaw.json)

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

### 配置参数说明

| 配置 | 说明 | 默认值 |
|-----|------|-------|
| `enabled` | 是否启用 | `true` |
| `embedding.baseURL` | Embedding API地址 | `http://localhost:11434` |
| `embedding.model` | Embedding模型 | `bge-m3` |
| `embedding.dimensions` | 向量维度 | `1024` |
| `translate.enabled` | 是否启用翻译 | `true` |
| `translate.provider` | 翻译provider | `ollama` |
| `translate.model` | 翻译模型 | `qwen2.5:7b` |
| `matching.skillMatchThreshold` | Skill匹配阈值(0-1) | `0.6` |
| `matching.maxSkills` | 最大注入skill数量 | `3` |

### 翻译Provider配置

| Provider | 环境变量 | 说明 |
|----------|---------|------|
| `ollama` | 无需配置 | 使用本地Ollama服务 |
| `minimax` | `MINIMAX_API_KEY` | 使用MiniMax API |
| `openai` | `OPENAI_API_KEY` | 使用OpenAI API |

## 工作流程

```
用户消息 → before_agent_start hook →
  (可选)翻译用户输入到英文 →
  获取embedding →
  与所有skills的embedding匹配 →
  匹配threshold以上的skills →
  注入到context的prependContext
```

## Skills来源

插件从以下目录扫描SKILL.md:
1. `~/.openclaw/skills/` - 全局skills
2. `~/.openclaw/workspace/.openclaw/skills/` - 工作区skills

**注意**: 当前只扫描本地目录,openclaw内置的bundled skills(如acp-router, coding-agent等)不在扫描范围内。

## 注入格式

当匹配到skills时,会在context前添加:

```
[Skill Auto-Injection] The current conversation may involve these available skills:
- [skill-name]: skill description...

Please consider using relevant skills to fulfill the user's request if applicable.
```

## 调试

```bash
# 查看插件日志
openclaw logs 2>&1 | grep skill-auto-injection

# 查看skills列表
openclaw skills list

# 重启网关
openclaw gateway restart
```

## 后续优化方向

1. **支持bundled skills**: 扫描openclaw内置skills目录
2. **交付任务检测**: 专门的交付任务句式检测(而非仅依赖embedding)
3. **白名单管理**: 支持通过配置维护skill白名单
4. **排除列表**: 支持排除不需要自动匹配的skills
5. **实时翻译优化**: 使用更快的翻译服务减少延迟

## 参考

- [OpenClaw Plugin SDK](https://github.com/openclaw/openclaw)
- [memory-recall插件](../memory-recall)
- [bge-m3 embedding](https://ollama.com/)
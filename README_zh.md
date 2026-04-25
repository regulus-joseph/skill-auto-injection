# Skill 自动注入插件

> 使用 embedding 相似度自动将用户交付任务与可用技能进行匹配

## 更新日志

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 0.1.0 | 2026-04-22 | 初始版本：基于 embedding 的技能匹配 |
| 0.2.0 | 2026-04-22 | 添加多提供商翻译（ollama/minimax/openai），优化日志 |
| 0.3.0 | 2026-04-25 | L1 关键字匹配（零开销）+ L2 embedding 级联；LLM 提取技能关键字；英文 query 跳过翻译 |

## 功能特性

- **双层匹配**：L1 关键字匹配（快速、零 LLM 消耗）+ L2 embedding 回退（语义、跨语言）
- **LLM 关键字提取**：技能加载时自动提取 3~5 个触发关键字，无需手动维护白名单
- **智能翻译**：query 已含英文字符时跳过翻译
- **技能匹配**：使用 embedding 模型将用户输入与技能描述进行匹配
- **多提供商翻译**：支持 Ollama、MiniMax、OpenAI 翻译提供商
- **上下文注入**：通过 `before_agent_start` 钩子自动注入匹配到的技能
- **缓存**：技能 embedding 和关键字缓存 5 分钟，避免重复计算

## 项目结构

```
skill-auto-injection/
├── openclaw.plugin.json    # 插件配置
├── package.json            # Node.js 包配置
├── vitest.config.ts        # 测试配置
├── src/
│   ├── index.ts            # 插件入口
│   └── utils.ts            # 纯工具函数
├── tests/
│   └── utils.test.ts       # 单元测试（34 个通过）
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

### 配置参数

| 配置项 | 描述 | 默认值 |
|--------|------|--------|
| `enabled` | 启用插件 | `true` |
| `embedding.baseURL` | Embedding API 地址 | `http://localhost:11434` |
| `embedding.model` | Embedding 模型 | `bge-m3` |
| `embedding.dimensions` | 向量维度 | `1024` |
| `translate.enabled` | 启用翻译 | `true` |
| `translate.provider` | 翻译提供商 | `ollama` |
| `translate.model` | 翻译模型 | `qwen2.5:7b` |
| `matching.skillMatchThreshold` | 技能匹配阈值 (0-1) | `0.6` |
| `matching.maxSkills` | 最大注入技能数 | `3` |
| `keyword.enabled` | 启用 L1 关键字匹配 | `true` |
| `keyword.model` | 关键字提取 LLM 模型 | `qwen2.5:7b` |
| `keyword.baseURL` | 覆盖关键字 LLM 的 baseURL | `null`（复用 embedding.baseURL）|

### 翻译提供商配置

| 提供商 | 环境变量 | 说明 |
|--------|----------|------|
| `ollama` | 无需配置 | 使用本地 Ollama |
| `minimax` | `MINIMAX_API_KEY` | 使用 MiniMax API |
| `openai` | `OPENAI_API_KEY` | 使用 OpenAI API |

## 工作流程

```
用户消息 → before_agent_start 钩子
  │
  ├── L1: 关键字匹配（零开销）
  │     从 query 中提取英文 token
  │     与技能触发关键字匹配
  │     → 命中 → 立即注入匹配到的技能
  │
  └── L2: Embedding 回退（仅 L1 未命中时）
        query 含英文字符？→ 跳过翻译
        否则 → 翻译为英文
        获取 embedding → Cosine 相似度 → 按阈值过滤
        → 注入 top-N 匹配技能
```

**关键字在技能加载时由 LLM 提取**（缓存 5 分钟），无需手动维护。

## 技能来源

插件扫描以下位置的 SKILL.md：
1. `~/.openclaw/skills/` - 全局技能
2. `~/.openclaw/workspace/.openclaw/skills/` - 工作区技能

**注意**：目前仅扫描本地目录。OpenClaw 打包的技能（acp-router、coding-agent 等）暂未包含。

## 注入格式

当技能匹配成功时，会在上下文前添加：

```
[技能自动注入] 当前对话可能涉及以下可用技能：
- [技能名称]: 技能描述...

如有需要，请考虑使用相关技能来满足用户请求。
```

## 测试

```bash
npm test          # 运行所有测试
npm run test:watch  # 监听模式
```

**34 个单元测试**，覆盖关键字匹配、分词、余弦相似度、markdown 解析和 L1/L2 级联逻辑。

## 调试

```bash
# 查看插件日志
openclaw logs 2>&1 | grep skill-auto-injection

# 列出技能
openclaw skills list

# 重启网关
openclaw gateway restart
```

## 未来改进

1. **打包技能支持**：扫描 OpenClaw 内置技能目录
2. **排除列表**：从自动匹配中排除特定技能
3. **用户反馈循环**：从用户纠正中学习（技能有用/无用）
4. **技能自动安装**：当高置信度匹配但技能未安装时，自动从 ClawHub 安装

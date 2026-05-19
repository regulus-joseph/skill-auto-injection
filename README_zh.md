# Skill AI Inject（中文）

> 使用 embedding 相似度自动将用户交付任务与可用技能进行匹配

## 版本

**v0.4.2** · OpenClaw 2026.5.x 兼容

---

## 概述

skill-ai-inject 会自动将用户输入与可用技能（来自本地 SKILL.md 文件）进行匹配，并将最匹配的技能注入到 agent 的提示上下文中。它使用双层级联：L1 关键字匹配（零成本，即时）→ L2 embedding 回退（语义，跨语言）。

**核心特性**：
- L1 关键字匹配，使用 LLM 提取的触发关键字（无需手动维护白名单）
- L2 embedding 回退，支持跨语言语义匹配
- 智能翻译：当查询已包含英文字符时跳过翻译
- 纯 Ollama：无需外部 API key

---

## 前置条件

### Ollama 模型

```bash
ollama pull bge-m3          # 用于 embedding 相似度
ollama pull qwen3.5:4b      # 用于关键字提取（带 think 模式）
ollama pull qwen2.5:3b      # 用于翻译（无 think，开销低，速度快）
```

> **翻译模型提示**：`qwen2.5:7b` 比 `qwen3.5` 系列更快，因为没有 think/推理开销。甚至更小的模型（如 `qwen2.5:3b`）也能很好地完成翻译任务。

---

## 安装

### 1. 构建插件

```bash
cd ~/projects/skill-ai-inject
npm install
npm run build
```

### 2. 链接插件到 OpenClaw

```bash
openclaw plugins install --link .
```

### 3. 配置 openclaw.json

```json
{
  "plugins": {
    "allow": ["memory-recall", "skill-ai-inject", "policy-layer", "minimax", "browser"],
    "bundledDiscovery": "allowlist",
    "entries": {
      "skill-ai-inject": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        },
        "config": {
          "embedding": {
            "baseURL": "http://localhost:11434",
            "model": "bge-m3",
            "dimensions": 1024
          },
          "translate": {
            "enabled": false,
            "model": "qwen2.5:3b"
          },
          "matching": {
            "skillMatchThreshold": 0.6,
            "maxSkills": 3,
            "minKeywordMatch": 1,
            "l2CandidateCount": 20
          },
          "keyword": {
            "enabled": true,
            "model": "qwen3.5:4b"
          }
        }
      }
    }
  }
}
```

### 4. 重启 gateway

```bash
openclaw gateway restart
```

### 5. 验证

```bash
openclaw plugins inspect skill-ai-inject
# 应显示：Status: loaded
```

---

## 配置

### 配置参数

| 配置项 | 描述 | 默认值 |
|--------|------|--------|
| `enabled` | 启用插件 | `true` |
| `embedding.baseURL` | Embedding API 地址 | `http://localhost:11434` |
| `embedding.model` | Embedding 模型 | `bge-m3` |
| `embedding.dimensions` | 向量维度 | `1024` |
| `translate.enabled` | 启用翻译 | `false` |
| `translate.model` | 翻译模型 | `qwen2.5:3b` |
| `matching.skillMatchThreshold` | 技能匹配阈值 (0-1) | `0.6` |
| `matching.maxSkills` | 最大注入技能数 | `3` |
| `matching.minKeywordMatch` | L1 命中最少关键字数 | `1` |
| `matching.l2CandidateCount` | L2 embedding 阶段最大候选数 | `20` |
| `keyword.enabled` | 启用 L1 关键字匹配 | `true` |
| `keyword.model` | LLM 关键字提取模型 | `qwen3.5:4b` |
| `keyword.baseURL` | 覆盖关键字 LLM 的 baseURL | `null`（复用 embedding.baseURL）|

**注意**：所有 LLM 操作均使用 Ollama 本地运行，无需外部 API key。

---

## OpenClaw 配置注意事项

### bundledDiscovery: "allowlist"

当 `bundledDiscovery` 设置为 `"allowlist"`（默认）时，`plugins.allow` 列表会过滤所有插件。请确保 `skill-ai-inject` 已列出：

```json
"plugins": {
  "allow": ["skill-ai-inject", ...]
}
```

### policy-layer AllowPromptInjection

如果 policy-layer 阻止了 prompt 注入，技能匹配结果将不会出现在上下文中：

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

## 工作流程

```
用户消息 → before_prompt_build 钩子
  │
  ├── L1: 关键字匹配（零成本）
  │     从 prompt 中提取英文 token
  │     与技能触发关键字匹配（命中比率评分）
  │     → 命中 → 立即注入匹配到的技能
  │
  └── L2: Embedding 回退（仅 L1 未命中时）
        查询包含英文字符？→ 跳过翻译
        否则 → 翻译为英文
        获取 embedding → Cosine 相似度 → 按阈值过滤
        → 注入 top-N 匹配技能
```

**关键字在技能加载时由 LLM 提取**（缓存 5 分钟），无需手动维护。

---

## 技能来源

插件扫描以下位置的 SKILL.md：
1. `~/.openclaw/skills/` — 全局技能
2. `~/.openclaw/workspace/.openclaw/skills/` — 工作区技能

**注意**：目前仅扫描本地目录。OpenClaw 打包的技能（acp-router、coding-agent 等）暂未包含。

---

## 注入格式

当技能匹配成功时，会在上下文前添加：

```
[Skill Auto-Injection] 当前对话可能涉及以下可用技能：
- [技能名称]: 技能描述...

如有需要，请考虑使用相关技能来满足用户请求。
```

---

## 调试

```bash
# 查看插件日志
openclaw logs 2>&1 | grep skill-ai-inject

# 检查插件状态
openclaw plugins inspect skill-ai-inject

# 列出可用技能
openclaw skills list

# 重启 gateway
openclaw gateway restart
```

---

## 已知问题

### 缺少 hooks 配置时钩子不会触发

**问题**：`before_prompt_build` 钩子即使插件成功加载也不会触发。

**解决方案**：你**必须**在插件条目下添加 `hooks` 配置：

```json
"entries": {
  "skill-ai-inject": {
    "enabled": true,
    "hooks": {
      "allowPromptInjection": true,
      "allowConversationAccess": true
    },
    ...
  }
}
```

没有此配置，钩子会静默失败 — 插件显示为已加载，但技能匹配永远不会运行。

- 仅扫描本地技能目录；不包含 OpenClaw 打包的技能
- 没有排除列表功能
- 没有用户反馈学习机制

---

## 版本历史

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 0.1.0 | 2026-04-22 | 初始版本：基于 embedding 的技能匹配 |
| 0.2.0 | 2026-04-22 | 添加多提供商翻译（ollama/minimax/openai），优化日志 |
| 0.3.0 | 2026-04-25 | L1 关键字匹配（零开销）+ L2 embed 级联；LLM 关键字提取；英文 query 跳过翻译 |
| **0.4.0** | 2026-05-10 | **反转 L1 匹配方向；切换至 `before_prompt_build` 钩子；命中比率评分；新增 l2CandidateCount** |
| **0.4.1** | 2026-05-16 | **项目重命名为 skill-ai-inject；重写 README 完善文档** |
| **0.4.2** | 2026-05-17 | **修复钩子注册：使用 api.registerHook；使用 event.prompt** |
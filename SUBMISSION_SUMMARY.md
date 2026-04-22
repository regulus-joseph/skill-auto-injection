# skill-auto-injection Plugin

## Summary

A plugin that automatically matches user delivery tasks with available skills using embedding similarity, then injects matched skills into the agent context before execution.

## Problem

Users need to manually discover and configure skills in ClawHub. When they say "write a WeChat article" or "help me post to Twitter," they expect the agent to know which skill to use — but the agent has no way to automatically find and load relevant skills.

## Solution

1. **Embed all installed skills** using bge-m3 (Ollama) for cross-language matching
2. **Match user messages** against skill embeddings with configurable threshold (default: 60%)
3. **Inject matched skills** via `before_agent_start` hook — no manual setup required

## Features

- Vector similarity search using Qdrant or in-memory fallback
- Multi-provider translation (Ollama, MiniMax, OpenAI) for cross-language matching
- Configurable similarity threshold per skill or globally
- Skill ranking: return top-N matches with confidence scores
- Supports Chinese ↔ English cross-language matching

## Why This Fills a Gap

- ClawHub requires manual search and install
- This plugin enables **passive skill discovery** — the agent auto-loads skills based on what the user asks
- Complementary to, not replacing, existing skill ecosystem

## Status

- Prototype complete (v0.2.0)
- Tested with bge-m3 embeddings + Qdrant
- Requires: Ollama with bge-m3 model, or cloudembedding API

## Interested?

Would love to get feedback on whether this fits OpenClaw's direction. Happy to iterate on the implementation or discuss alternative approaches.

Contact: [your Discord/email]
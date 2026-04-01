---
name: opencli
description: "OpenCLI — Make any website or Electron App your CLI. Zero risk, AI-powered, reuse Chrome login."
version: 1.5.6
author: jackwener
tags: [cli, browser, web, chrome-extension, cdp, AI, agent, operate]
---

# OpenCLI

> Make any website or Electron App your CLI. Reuse Chrome login, zero risk, AI-powered.

## Skills

OpenCLI has three specialized skills. Use the one that matches your task:

### 1. CLI Commands (`skills/cli/SKILL.md`)
Use existing CLI commands to fetch data, interact with websites and desktop apps.
```bash
opencli twitter trending --limit 10
opencli hackernews top --limit 5
opencli bilibili hot
```

### 2. Browser Automation (`skills/operate/SKILL.md`)
AI agent or manual browser control. Navigate, click, type, extract — with existing Chrome login sessions.
```bash
# AI agent mode (requires OPENCLI_API_KEY)
opencli operate "go to HN and extract top 5 stories"
opencli operate --save-as hn/top "get top HN stories"   # Save as reusable CLI

# Manual mode (Claude Code controls the loop)
opencli browse open https://example.com
opencli browse state
opencli browse click 3
```

### 3. Adapter Development (`skills/adapter-dev/SKILL.md`)
Create new CLI commands from websites. Explore APIs, record traffic, write TypeScript adapters.
```bash
opencli explore https://example.com
opencli record https://example.com
opencli generate https://example.com --goal "hot"
```

## Quick Setup

```bash
npm install -g @jackwener/opencli
opencli doctor    # Verify Chrome extension + daemon
```

## Configuration

```bash
# For AI agent (opencli operate)
export OPENCLI_PROVIDER=anthropic       # or openai
export OPENCLI_MODEL=sonnet             # model alias
export OPENCLI_API_KEY=sk-ant-...       # API key
export OPENCLI_BASE_URL=https://...     # optional proxy
```

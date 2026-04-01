---
name: opencli-operate
description: Browser automation via OpenCLI. Navigate websites, click elements, fill forms, extract data, and take screenshots — all using Chrome with existing login sessions. Use when the user needs to interact with web pages, fill forms, extract web data, or automate browser tasks.
allowed-tools: Bash(opencli:*)
---

# Browser Automation with OpenCLI

OpenCLI provides browser automation that reuses your existing Chrome login sessions — no passwords needed.

## Prerequisites

```bash
opencli doctor    # Verify extension + daemon + LLM connectivity
```

Requires: Chrome running + OpenCLI Browser Bridge extension installed.

## Two Modes

### Mode 1: AI Agent (fully autonomous)

Let the AI agent complete a task end-to-end:

```bash
opencli operate "go to Hacker News and extract the top 5 stories"
opencli operate --url https://github.com/trending "extract top 3 repos"
opencli operate -v "fill the login form with test@example.com"
```

Requires `OPENCLI_API_KEY` for LLM calls. See OPERATE.md for full config.

### Mode 2: Manual Commands (coming soon)

> `opencli browse` commands for step-by-step browser control are planned. This will let Claude Code drive the browser directly without LLM API costs.
>
> For now, use `opencli operate` (Mode 1) which handles the full loop automatically.

## Saving as Reusable CLI

After successfully completing a browser task, save it as a permanent CLI command:

### Via operate --save-as

```bash
opencli operate --save-as hn/top "get top 5 HN stories" --url https://news.ycombinator.com
# Future: opencli hn top (no LLM needed)
```

### Via Claude Code (recommended — higher quality)

After manually completing a task with `opencli browse` commands, write a TS adapter:

```typescript
// ~/.opencli/clis/hn/top.ts
import { cli, Strategy } from '@jackwener/opencli/registry';

cli({
  site: 'hn',
  name: 'top',
  description: 'Top Hacker News stories',
  domain: 'news.ycombinator.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'limit', type: 'int', default: 5 }],
  columns: ['rank', 'title', 'score', 'url'],
  func: async (_page, kwargs) => {
    const resp = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids = await resp.json();
    const items = await Promise.all(
      ids.slice(0, kwargs.limit).map(async (id, i) => {
        const item = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json();
        return { rank: i + 1, title: item.title, score: item.score, url: item.url };
      })
    );
    return items;
  },
});
```

Save to `~/.opencli/clis/<site>/<command>.ts`. The adapter is immediately available as `opencli <site> <command>`.

### Adapter Strategy Guide

Choose the simplest strategy that works:

| Strategy | When | browser: |
|----------|------|----------|
| `Strategy.PUBLIC` | No auth needed, public API available | `false` |
| `Strategy.COOKIE` | Needs login cookies, fetch with `credentials: 'include'` | `true` |
| `Strategy.INTERCEPT` | SPA that triggers API on navigation | `true` |
| `Strategy.UI` | Must interact with DOM directly | `true` |

**Always prefer API over UI** — if you discovered an API endpoint during browsing, use it directly with `fetch()`.

## Configuration

```bash
# For operate mode (AI agent)
export OPENCLI_PROVIDER=anthropic       # or openai
export OPENCLI_MODEL=sonnet             # model alias
export OPENCLI_API_KEY=sk-ant-...       # API key
export OPENCLI_BASE_URL=https://...     # optional proxy

# For browse mode (manual commands)
# No LLM config needed — just Chrome + extension
```

## Troubleshooting

- **"Extension not connected"** → `opencli doctor`
- **"attach failed: chrome-extension://"** → Disable 1Password or other debugger extensions temporarily
- **Element not found** → `opencli browse scroll down` then `opencli browse state`

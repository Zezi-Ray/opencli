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

### Mode 2: Manual Commands (Claude Code controls the loop)

Claude Code drives the browser step-by-step using CLI commands. **No LLM API key needed** — Claude Code IS the LLM.

#### Core Workflow

1. **Navigate**: open a URL
2. **Inspect**: get page state with element indices
3. **Interact**: use indices to click, type, select
4. **Verify**: check state or take screenshot
5. **Repeat**: browser stays open between commands

#### Navigation

```bash
opencli browse open <url>                    # Open URL in automation window
opencli browse back                          # Go back in history
opencli browse scroll down                   # Scroll down
opencli browse scroll up                     # Scroll up
```

#### Page State — always run this first to get element indices

```bash
opencli browse state                         # Returns: URL, title, interactive elements with [N] indices
opencli browse screenshot [path.png]         # Take screenshot (base64 if no path)
```

#### Interactions — use indices from state

```bash
opencli browse click <index>                 # Click element [N]
opencli browse type <index> "text"           # Click element [N], then type text
opencli browse select <index> "option"       # Select dropdown option
opencli browse keys "Enter"                  # Press keyboard key
opencli browse eval "document.title"         # Execute JavaScript, return result
```

#### Data Extraction

```bash
opencli browse eval "document.querySelectorAll('.item').length"
opencli browse eval "JSON.stringify([...document.querySelectorAll('h2')].map(e => e.textContent))"
```

#### Example: Extract HN Stories

```bash
opencli browse open https://news.ycombinator.com
opencli browse state                         # See elements: [1] a "Story 1", [2] a "Story 2"...
opencli browse eval "JSON.stringify([...document.querySelectorAll('.titleline a')].slice(0,5).map(a => ({title: a.textContent, url: a.href})))"
```

#### Example: Fill a Form

```bash
opencli browse open https://httpbin.org/forms/post
opencli browse state                         # See: [3] input "Customer Name", [4] input "Telephone"...
opencli browse type 3 "OpenCLI"
opencli browse type 4 "555-0100"
opencli browse click 7                       # Click submit (DON'T if user said "don't submit")
```

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

# opencli operate — AI Browser Automation

`opencli operate` lets an AI agent autonomously control your browser to complete tasks described in natural language. It reuses your existing Chrome login sessions, so no passwords needed.

## Quick Start

```bash
# Prerequisites: Chrome + OpenCLI extension installed, ANTHROPIC_API_KEY set
export ANTHROPIC_API_KEY=sk-ant-...

# Basic usage
opencli operate "go to Hacker News and extract the top 5 stories"

# With a starting URL
opencli operate --url https://github.com/trending "extract the top 3 trending repos"

# Watch the agent work (verbose mode)
opencli operate -v "search for flights from NYC to LA on Google Flights"
```

## How It Works

```
You describe a task in natural language
  → Agent observes the page (DOM snapshot)
  → LLM decides what to do (click, type, scroll, extract...)
  → Actions execute in your browser
  → Agent observes the result
  → Repeat until done
```

The agent uses your existing Chrome browser session through the OpenCLI extension, so it has access to all your logged-in accounts (Twitter, GitHub, Gmail, etc.) without needing passwords.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--url <url>` | — | Starting URL (agent navigates if omitted) |
| `--max-steps <n>` | 50 | Maximum agent steps before timeout |
| `--model <model>` | claude-sonnet-4-20250514 | LLM model to use |
| `--screenshot` | false | Include screenshots in LLM context (more accurate but more expensive) |
| `--record` | false | Record action trace for debugging |
| `--save-as <site/name>` | — | Save successful operation as reusable CLI skill |
| `-v, --verbose` | false | Show step-by-step reasoning |

## Save as Skill

After a successful operation, you can save it as a reusable CLI command that runs **without AI**:

```bash
# First run: AI agent completes the task
opencli operate --save-as hn/top "get the top 5 Hacker News stories" --url https://news.ycombinator.com

# Future runs: deterministic, no LLM needed
opencli hn top
```

The `--save-as` flag analyzes the agent's actions and captured network requests, then uses the LLM to generate an optimized TypeScript adapter. If the agent discovered an API during execution, the generated skill will call the API directly instead of replaying UI actions.

## Configuration

### Required

```bash
# Provider: anthropic (default) or openai
export OPENCLI_PROVIDER=anthropic

# Model: alias or full model ID
export OPENCLI_MODEL=sonnet          # aliases: sonnet, opus, haiku (anthropic)
                                     #          gpt-5.4, gpt-4.1, o3 (openai)

# API key for your provider
export OPENCLI_API_KEY=sk-ant-...

# Optional: API proxy
export OPENCLI_BASE_URL=https://your-proxy.com/api/anthropic
```

### Chrome Extension

The OpenCLI browser extension must be installed and connected. Run `opencli doctor` to check connectivity.

## Cost Estimate

Each `operate` run costs approximately **$0.01–$0.50** depending on task complexity:

| Task Type | Typical Steps | Estimated Cost |
|-----------|--------------|----------------|
| Simple extract (page title) | 1–2 | $0.01 |
| Search + extract | 3–6 | $0.05–0.15 |
| Form filling | 3–8 | $0.05–0.20 |
| Multi-step navigation | 5–10 | $0.10–0.50 |

Using `--save-as` adds one additional LLM call ($0.05–0.20) for skill generation.

## Troubleshooting

### "Extension not connected"
Run `opencli doctor` to diagnose. Make sure the OpenCLI extension is installed and enabled in Chrome.

### "attach failed: Cannot access a chrome-extension:// URL"
Another Chrome extension (usually 1Password or a debugger extension) is interfering. The agent will retry automatically, but if it persists, temporarily disable the conflicting extension.

### "LLM returned empty response"
Your API proxy may be truncating responses. Check your `ANTHROPIC_BASE_URL` configuration.

### Agent fills wrong fields or misses content below the fold
The agent scrolls elements into view before interacting, but complex pages with many dynamic elements can sometimes cause issues. Try running with `-v` to see what the agent sees and does.

## AutoResearch (Experimental)

OpenCLI includes an AutoResearch framework that automatically optimizes the agent's performance:

```bash
# Run automated optimization (requires Claude Code)
./autoresearch/run.sh
```

This uses Claude Code to iteratively modify the agent's code, evaluate against a test suite of 59 tasks, and commit only improvements. See `docs/superpowers/specs/2026-03-31-autoresearch-operate-design.md` for details.

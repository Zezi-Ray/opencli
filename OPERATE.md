# opencli operate — AI Browser Automation

`opencli operate` lets an AI agent autonomously control your browser to complete tasks described in natural language. It reuses your existing Chrome login sessions, so no passwords needed.

## Quick Start

```bash
# 1. Configure LLM provider
export OPENCLI_PROVIDER=anthropic       # or openai
export OPENCLI_MODEL=sonnet             # alias or full model ID
export OPENCLI_API_KEY=sk-ant-...       # your API key

# 2. Run
opencli operate "go to Hacker News and extract the top 5 stories"
opencli operate --url https://github.com/trending "extract the top 3 trending repos"
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
| `--screenshot` | false | Include screenshots in LLM context (more accurate but more expensive) |
| `--record` | false | Record action trace for debugging |
| `--save-as <site/name>` | — | Save successful operation as reusable CLI skill |
| `-v, --verbose` | false | Show step-by-step reasoning |

## Configuration

### Environment Variables

```bash
# Required
export OPENCLI_PROVIDER=anthropic       # Provider: anthropic or openai
export OPENCLI_API_KEY=sk-ant-...       # API key for your provider

# Optional
export OPENCLI_MODEL=sonnet             # Model alias or full ID (default: sonnet)
export OPENCLI_BASE_URL=https://...     # API proxy URL (must include /v1 for OpenAI proxies)
```

### Model Aliases

| Provider | Aliases | Default |
|----------|---------|---------|
| anthropic | `sonnet`, `opus`, `haiku` | sonnet |
| openai | `gpt-5.4`, `gpt-4.1`, `gpt-4o`, `o3`, `o4-mini` | gpt-4o |

You can also use full model IDs (e.g., `claude-sonnet-4-20250514`, `gpt-5.4`).

### Verify Configuration

```bash
opencli doctor    # Shows LLM provider, model, and connectivity status
```

### Chrome Extension

The OpenCLI browser extension must be installed and connected. Run `opencli doctor` to check.

## Save as Skill

After a successful operation, save it as a reusable CLI command that runs **without AI**:

```bash
# First run: AI agent completes the task
opencli operate --save-as hn/top "get the top 5 Hacker News stories" --url https://news.ycombinator.com

# Future runs: deterministic, no LLM needed
opencli hn top
```

The `--save-as` flag analyzes the agent's actions and captured network requests, then uses the LLM to generate an optimized TypeScript adapter. If the agent discovered an API during execution, the generated skill will call the API directly instead of replaying UI actions.

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

### "OPENCLI_API_KEY is not set"
Configure your LLM provider:
```bash
export OPENCLI_PROVIDER=anthropic
export OPENCLI_API_KEY=sk-ant-...
```

### "LLM returned HTML instead of JSON"
Your `OPENCLI_BASE_URL` is pointing to the proxy's dashboard, not its API endpoint. Add `/v1`:
```bash
export OPENCLI_BASE_URL='https://your-proxy.com/v1'
```

### "Extension not connected"
Run `opencli doctor` to diagnose. Make sure the OpenCLI extension is installed and enabled in Chrome.

### "attach failed: Cannot access a chrome-extension:// URL"
Another Chrome extension (usually 1Password or a debugger extension) is interfering. The agent retries automatically (up to 5 times for operate commands), but if it persists, temporarily disable the conflicting extension.

### "LLM returned empty response"
Your API proxy may be truncating responses, or the model name may not be supported by your proxy. Check `OPENCLI_MODEL` and `OPENCLI_BASE_URL`.

### Agent fills wrong fields or misses content below the fold
The agent scrolls elements into view before interacting, but complex pages with many dynamic elements can sometimes cause issues. Try running with `-v` to see what the agent sees and does.

## AutoResearch (Experimental)

OpenCLI includes an AutoResearch framework that automatically optimizes the agent's performance:

```bash
# Run automated optimization (requires Claude Code)
./autoresearch/run.sh
```

This uses Claude Code to iteratively modify the agent's code, evaluate against a test suite of 59 tasks, and commit only improvements. See `docs/superpowers/specs/2026-03-31-autoresearch-operate-design.md` for details.

# OpenCLI "open-operator" Implementation Plan

## Context

OpenCLI 是一个将网站转化为 CLI 命令的工具（TypeScript/Node.js），使用 Chrome Extension + daemon 架构进行浏览器自动化。当前所有浏览器交互都是**确定性的** — 通过 JS 注入执行固定脚本。

本计划为 OpenCLI 新增 **AI Agent 浏览器自动化能力**（代号 "open-operator"），实现 Browser Use 风格的 LLM 驱动控制循环：观察页面 → LLM 推理 → 执行动作 → 重复，直到任务完成。成功的操作可沉淀为可复用的 CLI skill。

**关键决策**：
- 在 OpenCLI 现有 Extension + daemon 架构上实现（`chrome.debugger` 已验证支持所有所需 CDP domain）
- TypeScript 实现（不引入 Python 子进程）
- 保留 OpenCLI 的核心优势：复用用户浏览器登录态

---

## Architecture

```
opencli operate "在 Google Flights 搜索航班"
  │
  ├── CLI (operate command) ──▶ AgentLoop
  │                              │
  │   Phase 1: Build Context     │  buildDomContext(page)
  │     - DOM snapshot (text)    │  → 现有 dom-snapshot.ts
  │     - Element coord map      │  → 新增坐标提取
  │     - Screenshot (optional)  │  → page.screenshot()
  │     - Action history         │  → 上一步结果
  │                              │
  │   Phase 2: Call LLM          │  Anthropic Claude API
  │     - System prompt          │  → 行为指令 + action schema
  │     - Structured JSON output │  → { thinking, memory, nextGoal, actions[] }
  │                              │
  │   Phase 3: Execute Actions   │  ActionExecutor
  │     - Native CDP Input.*     │  → dispatchMouseEvent/KeyEvent
  │     - 或 fallback JS 注入    │  → 现有 page.click/typeText
  │                              │
  │   Phase 4: Observe & Repeat  │  Loop detection, error recovery
  │                              │
  ├── --save-as site/name ──▶ Trace → YAML skill (复用 pipeline 系统)
  └── 输出: 结果 + token 用量 + 成本
```

---

## Phase 1: CDP Infrastructure Enhancement (~200 LOC modifications)

**Goal**: 添加 CDP passthrough 能力，支持原生 Input 事件

### 修改文件

| File | Change |
|------|--------|
| `extension/src/protocol.ts` | 添加 `'cdp'` action type, `cdpMethod/cdpParams` 字段 |
| `extension/src/background.ts` | 添加 `handleCdp()` — 转发 `chrome.debugger.sendCommand(method, params)` |
| `src/browser/daemon-client.ts` | 添加 `'cdp'` 到 action union, 新字段 |
| `src/types.ts` | IPage 新增可选方法: `cdp?()`, `nativeClick?()`, `nativeType?()`, `nativeKeyPress?()`, `getElementBounds?()` |
| `src/browser/page.ts` | 实现新 IPage 方法（通过 daemon 调用 CDP passthrough） |

### 核心设计：CDP Passthrough

不为每个 CDP 方法单独加 handler，而是添加一个通用 `cdp` action，直接转发 `chrome.debugger.sendCommand(method, params)`。Agent 可访问任意 CDP domain，无需修改协议。

所有新方法标记为 `?`（可选），**不影响现有 300+ CLI 命令**。

---

## Phase 2: LLM-Ready DOM Context (~250 LOC new)

**Goal**: 在现有 `dom-snapshot.ts` 基础上，补充元素坐标映射

### 新文件

**`src/agent/dom-context.ts`**

- 复用 `page.snapshot()` 获取 LLM 友好的文本（`[42]<button>Login</button>` 格式）
- 额外运行一段 JS 收集所有 `[data-opencli-ref]` 元素的 `getBoundingClientRect()`
- 输出 `DomContext`: `{ snapshotText, elementMap: Map<index, {center, bbox, tag, text}>, url, title, viewport }`

**关键洞察**：OpenCLI 的 `dom-snapshot.ts` 已经实现了 Browser Use 的 DOM 序列化的 13/15 功能（交互元素索引、可见性过滤、遮挡检测、Shadow DOM、iframe 等），只差坐标映射。

---

## Phase 3: Agent Loop Core (~1100 LOC new)

**Goal**: LLM 驱动的浏览器控制循环

### 新依赖

```json
"zod": "^3.23.0",
"@anthropic-ai/sdk": "^0.39.0"
```

### 新文件

| File | ~LOC | Purpose |
|------|------|---------|
| `src/agent/types.ts` | 150 | Zod schemas: actions (click/type/navigate/scroll/wait/extract/done/go_back/press_key), AgentResponse, AgentConfig |
| `src/agent/prompts.ts` | 200 | System prompt template, per-step message builder, error recovery message |
| `src/agent/llm-client.ts` | 150 | Anthropic SDK wrapper, token tracking, JSON 解析 + Zod 验证 |
| `src/agent/action-executor.ts` | 250 | Action dispatch: LLM action → IPage 方法调用（优先 native CDP，fallback JS 注入） |
| `src/agent/agent-loop.ts` | 350 | 核心循环: context → LLM → execute → observe → repeat；含 loop detection、message compaction、budget warning |
| `src/agent/index.ts` | 10 | Barrel exports |

### Agent Loop 细节

```
while (step < maxSteps && !done) {
  1. domContext = buildDomContext(page)
  2. screenshot = opts.screenshot ? page.screenshot() : null
  3. message = buildStepMessage(domContext, previousResults, screenshot)
  4. response = llm.chat(systemPrompt, messageHistory)   // → AgentResponse
  5. for (action of response.actions) {
       if (action.type === 'done') → return success
       result = executor.execute(action, domContext.elementMap)
       if (result.error) consecutiveErrors++
       else consecutiveErrors = 0
     }
  6. Loop detection: 最近 3 步动作序列相同 → 注入 "try different approach" 警告
  7. Message compaction: 历史超过 20 轮 → 压缩旧步骤
  8. Verbose output: step#, thinking, actions, results
}
```

---

## Phase 4: CLI Integration (~300 LOC)

**Goal**: `opencli operate <task>` 命令

### 修改文件

| File | Change |
|------|--------|
| `src/cli.ts` | 添加 `operate` 命令（alias `op`），跟 explore/record 同样的模式 |
| `src/errors.ts` | 添加 `AgentError`, `AgentBudgetError` |

### 新文件

**`src/agent/cli-handler.ts`** (~150 LOC)

CLI-to-agent bridge：验证 API key → 创建 browser session → 运行 AgentLoop → 渲染结果

### 命令用法

```bash
# 基础用法
opencli operate "在 GitHub 上 star browser-use 项目"

# 指定起始 URL
opencli operate --url https://flights.google.com "搜索 3月15日 北京到东京的航班"

# 录制并保存为 skill
opencli operate --save-as flights/search "搜索航班" --url https://flights.google.com

# 详细输出（显示每步推理）
opencli operate -v "在 Hacker News 上找到今天最热门的 AI 文章"

# 使用 screenshot 模式（更贵但更准确）
opencli operate --screenshot "填写这个表单"
```

---

## Phase 5: Skill Sedimentation (~350 LOC new)

**Goal**: 成功操作 → 可复用的 YAML CLI 命令

### 新文件

| File | ~LOC | Purpose |
|------|------|---------|
| `src/agent/trace-recorder.ts` | 150 | 录制每步动作 + 解析 durable CSS selector（优先 data-testid > id > aria-label > 结构路径） |
| `src/agent/skill-saver.ts` | 200 | Trace → YAML pipeline 转换，写入 `~/.opencli/clis/<site>/<name>.yaml` |

### 沉淀流程

```
Agent 执行: click[42] → type[73, "北京"] → click[88] → extract
     ↓ TraceRecorder
Trace: [{ action: click, selector: "[data-testid='search-btn']" },
        { action: type, selector: "#origin", text: "{{args.from}}" }, ...]
     ↓ SkillSaver
YAML: steps:
        - navigate: https://flights.google.com
        - evaluate: "document.querySelector('[data-testid=search-btn]').click()"
        - evaluate: "..."  (focus + type)
        - ...
     ↓ 写入 ~/.opencli/clis/flights/search.yaml
     ↓ 下次直接 `opencli flights search --from 北京 --to 东京`
```

生成的 YAML 兼容现有 `executePipeline()` 系统，**无需 LLM 即可重放**。

---

## File Summary

### New Files (11 files, ~2200 LOC)

| File | Phase | ~LOC |
|------|-------|------|
| `src/agent/types.ts` | 3 | 150 |
| `src/agent/dom-context.ts` | 2 | 250 |
| `src/agent/prompts.ts` | 3 | 200 |
| `src/agent/llm-client.ts` | 3 | 150 |
| `src/agent/action-executor.ts` | 3 | 250 |
| `src/agent/agent-loop.ts` | 3 | 350 |
| `src/agent/cli-handler.ts` | 4 | 150 |
| `src/agent/trace-recorder.ts` | 5 | 150 |
| `src/agent/skill-saver.ts` | 5 | 200 |
| `src/agent/index.ts` | 3 | 10 |

### Modified Files (7 files, ~200 LOC additions)

| File | Phase |
|------|-------|
| `extension/src/protocol.ts` | 1 |
| `extension/src/background.ts` | 1 |
| `src/browser/daemon-client.ts` | 1 |
| `src/types.ts` | 1 |
| `src/browser/page.ts` | 1 |
| `src/errors.ts` | 4 |
| `src/cli.ts` | 4 |

---

## Dependency Graph

```
Phase 1 (CDP)  ←──────── foundational
  │
  ├── Phase 2 (DOM Context)
  │     │
  │     └──▶ Phase 3 (Agent Loop) ←── depends on 1 + 2
  │               │
  │               ├──▶ Phase 4 (CLI) ←── thin wrapper
  │               │
  │               └──▶ Phase 5 (Skill Save) ←── post-processing
```

Phase 1 和 2 可以并行开发。Phase 3 依赖两者。Phase 4 是薄壳。Phase 5 在 Phase 3 稳定后实现。

---

## Verification Plan

### Phase 1 验证
```bash
# 在 worktree 中构建 extension
cd ~/code/opencli/.claude/worktrees/open-operator/extension && npm run build

# 测试 CDP passthrough
node -e "
  // 通过 daemon 发送 CDP 命令
  // 验证 Accessibility.getFullAXTree() 返回 AX tree
  // 验证 Input.dispatchMouseEvent() 产生 isTrusted:true 事件
"
```

### Phase 2-3 验证
```bash
# 在 worktree 中编译
cd ~/code/opencli/.claude/worktrees/open-operator && npm run build

# 基础 agent 测试
OPENCLI_API_KEY=... node dist/main.js operate "go to example.com and tell me the page title" -v
```

### Phase 4-5 验证
```bash
# 完整流程测试：operate → save → replay
OPENCLI_API_KEY=... node dist/main.js operate \
  --save-as test/example \
  --url https://example.com \
  "find the main heading text" -v

# 验证 skill 已保存
cat ~/.opencli/clis/test/example.yaml

# 重放（无需 LLM）
node dist/main.js test example
```

### 运行现有测试
```bash
cd ~/code/opencli/.claude/worktrees/open-operator && npm test
```

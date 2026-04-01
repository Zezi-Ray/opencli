---
name: opencli-adapter-dev
description: "OpenCLI adapter development — create new CLI commands from websites. Use when the user wants to build a new adapter, explore website APIs, record API calls, or write TypeScript/YAML adapters."
allowed-tools: Bash(opencli:*), Read, Edit, Write
---

# OpenCLI Adapter Development

> **Before creating adapters, read [CLI-EXPLORER.md](../../CLI-EXPLORER.md) for the complete API discovery workflow.**

## Key Rules

1. Main parameter uses positional arg (not `--query` / `--id`)
2. Use `CliError` subclasses for expected failures, not raw `Error`
3. Update adapter docs and README when adding new adapters

## Record Workflow

`record` 是为「无法用 `explore` 自动发现」的页面（需要登录操作、复杂交互、SPA 内路由）准备的手动录制方案。

### 工作原理

```
opencli record <url>
  → 打开 automation window 并导航到目标 URL
  → 向所有 tab 注入 fetch/XHR 拦截器（幂等，可重复注入）
  → 每 2s 轮询一次：发现新 tab 自动注入，drain 所有 tab 的捕获缓冲区
  → 超时（默认 60s）或按 Enter 停止
  → 分析捕获到的 JSON 请求：去重 → 评分 → 生成候选 YAML
```

**拦截器特性**：
- 同时 patch `window.fetch` 和 `XMLHttpRequest`
- 只捕获 `Content-Type: application/json` 的响应
- 过滤纯对象少于 2 个 key 的响应（避免 tracking/ping）
- 跨 tab 隔离：每个 tab 独立缓冲区，轮询时分别 drain
- 幂等注入：同一 tab 二次注入时先 restore 原始函数再重新 patch，不丢失已捕获数据

### 使用步骤

```bash
# 1. 启动录制（建议 --timeout 给足操作时间）
opencli record "https://example.com/page" --timeout 120000

# 2. 在弹出的 automation window 里正常操作页面：
#    - 打开列表、搜索、点击条目、切换 Tab
#    - 凡是触发网络请求的操作都会被捕获

# 3. 完成操作后按 Enter 停止（或等超时自动停止）

# 4. 查看结果
cat .opencli/record/<site>/captured.json        # 原始捕获
ls  .opencli/record/<site>/candidates/          # 候选 YAML
```

### 页面类型与捕获预期

| 页面类型 | 预期捕获量 | 说明 |
|---------|-----------|------|
| 列表/搜索页 | 多（5~20+） | 每次搜索/翻页都会触发新请求 |
| 详情页（只读） | 少（1~5） | 首屏数据一次性返回，后续操作走 form/redirect |
| SPA 内路由跳转 | 中等 | 路由切换会触发新接口，但首屏请求在注入前已发出 |
| 需要登录的页面 | 视操作而定 | 确保 Chrome 已登录目标网站 |

> **注意**：如果页面在导航完成前就发出了大部分请求（服务端渲染 / SSR 注水），拦截器会错过这些请求。
> 解决方案：在页面加载完成后，手动触发能产生新请求的操作（搜索、翻页、切 Tab、展开折叠项等）。

### 候选 YAML → TS CLI 转换

生成的候选 YAML 是起点，通常需要转换为 TypeScript（尤其是 tae 等内部系统）：

**候选 YAML 结构**（自动生成）：
```yaml
site: tae
name: getList          # 从 URL path 推断的名称
strategy: cookie
browser: true
pipeline:
  - navigate: https://...
  - evaluate: |
      (async () => {
        const res = await fetch('/approval/getList.json?procInsId=...', { credentials: 'include' });
        const data = await res.json();
        return (data?.content?.operatorRecords || []).map(item => ({ ... }));
      })()
```

**转换为 TS CLI**（参考 `src/clis/tae/add-expense.ts` 风格）：
```typescript
import { cli, Strategy } from '../../registry.js';

cli({
  site: 'tae',
  name: 'get-approval',
  description: '查看报销单审批流程和操作记录',
  domain: 'tae.alibaba-inc.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'proc_ins_id', type: 'string', required: true, positional: true, help: '流程实例 ID（procInsId）' },
  ],
  columns: ['step', 'operator', 'action', 'time'],
  func: async (page, kwargs) => {
    await page.goto('https://tae.alibaba-inc.com/expense/pc.html?_authType=SAML');
    await page.wait(2);
    const result = await page.evaluate(`(async () => {
      const res = await fetch('/approval/getList.json?taskId=&procInsId=${kwargs.proc_ins_id}', {
        credentials: 'include'
      });
      const data = await res.json();
      return data?.content?.operatorRecords || [];
    })()`);
    return (result as any[]).map((r, i) => ({
      step: i + 1,
      operator: r.operatorName || r.userId,
      action: r.operationType,
      time: r.operateTime,
    }));
  },
});
```

**转换要点**：
1. URL 中的动态 ID（`procInsId`、`taskId` 等）提取为 `args`
2. `captured.json` 里的真实 body 结构用于确定正确的数据路径（如 `content.operatorRecords`）
3. tae 系统统一用 `{ success, content, errorCode, errorMsg }` 外层包裹，取数据要走 `content.*`
4. 认证方式：cookie（`credentials: 'include'`），不需要额外 header
5. 文件放入 `src/clis/<site>/`，无需手动注册，`npm run build` 后自动发现

### 故障排查

| 现象 | 原因 | 解法 |
|------|------|------|
| 捕获 0 条请求 | 拦截器注入失败，或页面无 JSON API | 检查 daemon 是否运行：`curl localhost:19825/status` |
| 捕获量少（1~3 条） | 页面是只读详情页，首屏数据已在注入前发出 | 手动操作触发更多请求（搜索/翻页），或换用列表页 |
| 候选 YAML 为 0 | 捕获到的 JSON 都没有 array 结构 | 直接看 `captured.json` 手写 TS CLI |
| 新开的 tab 没有被拦截 | 轮询间隔内 tab 已关闭 | 缩短 `--poll 500` |
| 二次运行 record 时数据不连续 | 正常，每次 `record` 启动都是新的 automation window | 无需处理 |

## Creating Adapters

> [!TIP]
> **快速模式**：如果你只想为一个具体页面生成一个命令，直接看 [CLI-ONESHOT.md](./CLI-ONESHOT.md)。
> 只需要一个 URL + 一句话描述，4 步搞定。

> [!IMPORTANT]
> **完整模式 — 在写任何代码之前，先阅读 [CLI-EXPLORER.md](./CLI-EXPLORER.md)。**
> 它包含：① AI Agent 浏览器探索工作流 ② 认证策略决策树 ③ 平台 SDK（如 Bilibili 的 `apiGet`/`fetchJson`）④ YAML vs TS 选择指南 ⑤ `tap` 步骤调试方法 ⑥ 级联请求模板 ⑦ 常见陷阱表。
> **下方仅为简化模板参考，直接使用极易踩坑。**

### YAML Pipeline (declarative, recommended)

Create `src/clis/<site>/<name>.yaml`:

```yaml
site: mysite
name: hot
description: Hot topics
domain: www.mysite.com
strategy: cookie        # public | cookie | header | intercept | ui
browser: true

args:
  limit:
    type: int
    default: 20
    description: Number of items

pipeline:
  - navigate: https://www.mysite.com

  - evaluate: |
      (async () => {
        const res = await fetch('/api/hot', { credentials: 'include' });
        const d = await res.json();
        return d.data.items.map(item => ({
          title: item.title,
          score: item.score,
        }));
      })()

  - map:
      rank: ${{ index + 1 }}
      title: ${{ item.title }}
      score: ${{ item.score }}

  - limit: ${{ args.limit }}

columns: [rank, title, score]
```

For public APIs (no browser):

```yaml
strategy: public
browser: false

pipeline:
  - fetch:
      url: https://api.example.com/hot.json
  - select: data.items
  - map:
      title: ${{ item.title }}
  - limit: ${{ args.limit }}
```

### TypeScript Adapter (programmatic)

Create `src/clis/<site>/<name>.ts`. It will be automatically dynamically loaded (DO NOT manually import it in `index.ts`):

```typescript
import { cli, Strategy } from '../../registry.js';

cli({
  site: 'mysite',
  name: 'search',
  strategy: Strategy.INTERCEPT, // Or COOKIE
  args: [{ name: 'query', required: true, positional: true }],
  columns: ['rank', 'title', 'url'],
  func: async (page, kwargs) => {
    await page.goto('https://www.mysite.com/search');
    
    // Inject native XHR/Fetch interceptor hook
    await page.installInterceptor('/api/search');
    
    // Auto scroll down to trigger lazy loading
    await page.autoScroll({ times: 3, delayMs: 2000 });
    
    // Retrieve intercepted JSON payloads
    const requests = await page.getInterceptedRequests();
    
    let results = [];
    for (const req of requests) {
      results.push(...req.data.items);
    }
    return results.map((item, i) => ({
      rank: i + 1, title: item.title, url: item.url,
    }));
  },
});
```

**When to use TS**: XHR interception (`page.installInterceptor`), infinite scrolling (`page.autoScroll`), cookie extraction, complex data transforms (like GraphQL unwrapping).

## Pipeline Steps

| Step | Description | Example |
|------|-------------|---------|
| `navigate` | Go to URL | `navigate: https://example.com` |
| `fetch` | HTTP request (browser cookies) | `fetch: { url: "...", params: { q: "..." } }` |
| `evaluate` | Run JavaScript in page | `evaluate: \| (async () => { ... })()` |
| `select` | Extract JSON path | `select: data.items` |
| `map` | Map fields | `map: { title: "${{ item.title }}" }` |
| `filter` | Filter items | `filter: item.score > 100` |
| `sort` | Sort items | `sort: { by: score, order: desc }` |
| `limit` | Cap result count | `limit: ${{ args.limit }}` |
| `intercept` | Declarative XHR capture | `intercept: { trigger: "navigate:...", capture: "api/hot" }` |
| `tap` | Store action + XHR capture | `tap: { store: "feed", action: "fetchFeeds", capture: "homefeed" }` |
| `snapshot` | Page accessibility tree | `snapshot: { interactive: true }` |
| `click` | Click element | `click: ${{ ref }}` |
| `type` | Type text | `type: { ref: "@1", text: "hello" }` |
| `wait` | Wait for time/text | `wait: 2` or `wait: { text: "loaded" }` |
| `press` | Press key | `press: Enter` |

## Template Syntax

```yaml
# Arguments with defaults
${{ args.query }}
${{ args.limit | default(20) }}

# Current item (in map/filter)
${{ item.title }}
${{ item.data.nested.field }}

# Index (0-based)
${{ index }}
${{ index + 1 }}
```

## 5-Tier Authentication Strategy

| Tier | Name | Method | Example |
|------|------|--------|---------|
| 1 | `public` | No auth, Node.js fetch | Hacker News, V2EX |
| 2 | `cookie` | Browser fetch with `credentials: include` | Bilibili, Zhihu |
| 3 | `header` | Custom headers (ct0, Bearer) | Twitter GraphQL |
| 4 | `intercept` | XHR interception + store mutation | 小红书 Pinia |
| 5 | `ui` | Full UI automation (click/type/scroll) | Last resort |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLI_DAEMON_PORT` | 19825 | Daemon listen port |
| `OPENCLI_BROWSER_CONNECT_TIMEOUT` | 30 | Browser connection timeout (sec) |
| `OPENCLI_BROWSER_COMMAND_TIMEOUT` | 45 | Command execution timeout (sec) |
| `OPENCLI_BROWSER_EXPLORE_TIMEOUT` | 120 | Explore timeout (sec) |
| `OPENCLI_VERBOSE` | — | Show daemon/extension logs |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `npx not found` | Install Node.js: `brew install node` |
| `Extension not connected` | 1) Chrome must be open 2) Install opencli Browser Bridge extension |
| `Target page context` error | Add `navigate:` step before `evaluate:` in YAML |
| Empty table data | Check if evaluate returns correct data path |
| Daemon issues | `curl localhost:19825/status` to check, `curl localhost:19825/logs` for extension logs |

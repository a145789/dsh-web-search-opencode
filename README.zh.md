# dsh-web-search-opencode

为 DeepSeek Harness（`dsh`）的 `ctx.web` 搜索能力缝提供 **OpenCode 同款网页搜索**：
免 key 的 Exa / Parallel MCP 搜索后端，带自动故障切换。因此 `web_search` 在
**任意模型线路**（包括 `opencode-go`）上都可用，无需 DeepSeek 官方 API key。

## 为什么需要它

官方后端 `@deepseek-ai/dsh-web-search-deepseek` 走 Anthropic 兼容的 Messages API
加服务端 `web_search_20250305` 工具，必须有 DeepSeek 官方 API key。用 opencode-go
key 驱动会话时聊天正常，但每次 `web_search` 都报
`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。

opencode 本身没有这个问题：它的网页搜索是**客户端直连**第三方 MCP 端点，发一条
JSON-RPC `tools/call`。`opencode.ai/zen/go/v1` 根本没有搜索端点，网关不参与：

| 后端 | 端点 | 工具名 |
| --- | --- | --- |
| Exa | `https://mcp.exa.ai/mcp` | `web_search_exa` |
| Parallel | `https://search.parallel.ai/mcp` | `web_search` |

两者都免 key 可用。本插件把这套协议注册为 `WebSearchProvider`：

```
模型（如 opencode-go/deepseek-v4.1-flash）
  → web_search 工具                      （官方 @deepseek-ai/dsh-tool-web）
  → ctx.web.search()                     （官方 @deepseek-ai/dsh-web 能力缝）
  → OpenCodeSearchProvider.search()      ← 本插件
  → JSON-RPC tools/call → Exa / Parallel MCP
  → { content: 全文, sources: [{url,title,snippet,publishedAt}] }
  → tool-web 渲染成 markdown 交给模型
```

## 相比「照搬 opencode 行为」多做了什么

- **故障切换**：Exa 匿名端点额度用完后不再返回结果，而是 HTTP 429（或 HTTP 200
  加一段提示文本）。这些响应会被识别出来（状态码、JSON-RPC error、提示正文都覆盖），
  改由另一个后端回答查询，模型不会把「限流提示」当成搜索结果。固定单个后端时，
  只有额度耗尽才切换，其他失败照实上报。
- **结构化来源**：Parallel 的 JSON 布局、Exa 的 `---` 分块布局，以及通用逐行扫描器
  都会解析进能力缝的引用列表。只有「独占一行」的 URL 才算引用，所以提示文本里引用的
  端点地址（"把 MCP URL 改成 …"）不会变成假来源。
- **精确的取消语义**：调用方 `AbortSignal` 与请求超时预算保持可区分——取消是
  `WEB_ABORTED`，超时是 `WEB_PROVIDER_ERROR`。
- **零运行时依赖**：装进 profile 的 bundle 无法可靠解析 harness 内部包
  （`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-web`、`@deepseek-ai/cordis` 在
  profile 目录下都解析失败），因此 provider 自带结构兼容的 `WebError`，`Config`
  以标准 Standard Schema 对象导出——正是 loader `resolveConfig` 消费的形式。

## 安装

```bash
dsh plugin --profile web add github:a145789/dsh-web-search-opencode
```

要可复现安装，在末尾追加 `#<commit-sha>` 锁定提交。

包内已提交运行所需文件（`index.js`、`lib/`），且没有声明 `prepare`/`postinstall`
脚本，所以 git 安装**无需构建步骤**，也不会被 pnpm 的 `allowBuilds` 白名单拦住。

装完重启 harness —— 运行中的实例只在启动时加载插件树：

```bash
dsh web
```

卸载：`dsh plugin --profile web remove dsh-web-search-opencode`。

### 开发调试用

想直接改本地源码迭代，就装本地目录（pnpm 用 link，改动即时生效）：

```bash
dsh plugin --profile web add /path/to/dsh-web-search-opencode
```

bundle 补丁做两件事：

1. 插入 `web-search-opencode` 行；
2. 用 `searchProvider: opencode` 重述 `web` 行。

这个 pin 是必要的：如果不 pin，而 profile 里官方 `web-search-deepseek` 行也可用
（存在真实 `DEEPSEEK_API_KEY`），就会注册两个可用搜索后端，每次搜索都报
`WEB_PROVIDER_AMBIGUOUS`。

## 配置

默认无需配置。在 profile 的 `cordis.patch.yml`（设置 → 插件）覆盖该行 `config`，
或设置环境变量：

| 配置项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `provider` | `OPENCODE_WEBSEARCH_PROVIDER` | `auto` | `auto`（按查询分配并切换）\| `exa` \| `parallel` |
| `exaApiKey` | `EXA_API_KEY` | 空 | 以 `?exaApiKey=` 附加，同 opencode |
| `parallelApiKey` | `PARALLEL_API_KEY` | 空 | 以 `Authorization: Bearer` 发送 |
| `numResults` | — | `8` | 向后端请求的结果数 |
| `searchType` | — | `auto` | Exa 检索模式：`auto` \| `fast` \| `deep` |
| `livecrawl` | — | `fallback` | Exa 实时爬取策略：`fallback` \| `preferred` |
| `contextMaxCharacters` | — | `10000` | Exa 每结果上下文上限 |
| `modelName` | — | 未设置 | 作为 `model_name` 转发给 Parallel |
| `timeoutMs` | — | `25000` | 单请求预算，与 opencode 一致 |

## 谁掌握搜索选择权

任何注册搜索后端的插件都可能同时抢占能力缝的选择权。
`@mars-sea/dsh-commandcode-provider` 就是这么做的：它的「Serve dsh web search with
Command Code」开关（`webSearch`，默认开启）会在激活时覆写 `searchProviderId`，
于是模型侧的 `web_search` 走 Command Code 的计划内端点——一旦该计划周额度用尽，
即使此时还有免 key 后端可用，也会报它自己的 `HTTP 429 RATE_LIMITED`。

把选择权交回本插件，在该行上设 `webSearch: false`：

```yaml
- id: llm-commandcode
  name: "@mars-sea/dsh-commandcode-provider"
  config:
    webSearch: false
```

设为 `false` 时该插件在启动阶段不碰选择权，本 bundle 的
`searchProvider: opencode` 得以保留。该开关下一次搜索即生效，无需重启。

## 开发

```bash
npm test          # node --test，已 stub fetch，不联网，无依赖
npm run smoke     # 对两个真实端点做在线搜索（需要网络）
```

```
dsh-web-search-opencode/
├── package.json          # dsh.bundle.patch + locale/icon 导出
├── cordis.patch.yml      # bundle 层：插入插件行并 pin web.searchProvider
├── index.js              # cordis 插件：name / inject / Config / apply
├── lib/
│   ├── provider.js       # OpenCodeSearchProvider、MCP 协议、解析器、故障切换
│   └── types.js          # JSDoc 线上格式与能力缝词汇
├── locale/{en,zh}.json   # 插件清单显示元数据
├── icon.svg              # 插件清单图标
├── tests/provider.test.js
└── scripts/smoke.mjs
```

## 致谢

[lib/provider.js](lib/provider.js) 中的 MCP 线上协议复刻与 Exa/Parallel 结果解析器
衍生自 [FANXING-0710/dsh-web-search-opencode](https://github.com/FANXING-0710/dsh-web-search-opencode)——
该项目在 `package.json` 与 `README.md` 中声明 MIT 许可（仓库内没有独立 `LICENSE` 文件）。
本实现新增了双后端额度感知故障切换、来源 URL 的独占行过滤，以及零依赖的包结构。
详见 [NOTICE](NOTICE)。

## License

MIT

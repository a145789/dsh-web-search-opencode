# dsh-web-search-opencode

OpenCode-style web search for the DeepSeek Harness `ctx.web` seam: a keyless
Exa / Parallel MCP search provider with automatic failover, so `web_search`
works on **any** model route — including `opencode-go` — without a DeepSeek
official API key.

## Why this exists

The shipped provider (`@deepseek-ai/dsh-web-search-deepseek`) searches through the
Anthropic-compatible Messages API with the `web_search_20250305` server tool, so
it needs a DeepSeek official API key. Drive the harness with an `opencode-go` key
and chat works, but every `web_search` fails with
`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.

opencode itself never has that problem: it runs web search **client-side**,
posting a JSON-RPC `tools/call` frame straight to a third-party MCP endpoint.
`opencode.ai/zen/go/v1` has no search endpoint at all, so the gateway is not
involved:

| backend  | endpoint                         | tool name        |
| -------- | -------------------------------- | ---------------- |
| Exa      | `https://mcp.exa.ai/mcp`         | `web_search_exa` |
| Parallel | `https://search.parallel.ai/mcp` | `web_search`     |

Both work without a key. This plugin replicates that protocol as a
`WebSearchProvider`:

```
model (e.g. opencode-go/deepseek-v4.1-flash)
  → web_search tool                     (shipped @deepseek-ai/dsh-tool-web)
  → ctx.web.search()                    (shipped @deepseek-ai/dsh-web seam)
  → OpenCodeSearchProvider.search()     ← this plugin
  → JSON-RPC tools/call → Exa / Parallel MCP
  → { content: full text, sources: [{url,title,snippet,publishedAt}] }
  → tool-web renders markdown for the model
```

## What it adds over a literal port of opencode's behavior

- **Failover.** Exa's anonymous endpoint spends a free quota and then answers
  HTTP 429 (or HTTP 200 with a notice body) instead of results. That response is
  recognized — status, JSON-RPC error, notice text and all — and the sibling
  backend answers the query, so the model never receives a rate-limit notice as
  if it were search results. A pinned backend still fails over when its quota is
  spent, but reports every other failure honestly.
- **Structured sources.** Parallel's JSON layout, Exa's `---`-separated block
  layout, and a generic line scanner are parsed into the seam's citation list.
  A URL must occupy its own line to be a citation, so endpoint URLs quoted inside
  instructions ("update the MCP URL to …") never become fake sources.
- **Exact cancellation semantics.** The caller's `AbortSignal` and the request
  budget are kept distinguishable: a cancelled search is `WEB_ABORTED`, a budget
  expiry is `WEB_PROVIDER_ERROR`.
- **No runtime imports.** A profile-installed bundle cannot reliably resolve
  harness internals (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-web`,
  `@deepseek-ai/cordis` all fail to resolve from the profile directory), so the
  provider carries a structurally compatible `WebError` and exports its `Config`
  as a plain Standard Schema — exactly what the loader's `resolveConfig`
  consumes.

## Install

```bash
dsh plugin --profile web add github:a145789/dsh-web-search-opencode
```

Pin a commit for a reproducible install: append `#<commit-sha>`.

The package ships its runtime files (`index.js`, `lib/`) already committed, and
declares no `prepare`/`postinstall` script, so the git install needs no build step
and never trips pnpm's `allowBuilds` gate.

After installing, restart the harness — a running instance loads its plugin tree
at boot:

```bash
dsh web
```

Uninstall with `dsh plugin --profile web remove dsh-web-search-opencode`.

### For development

To iterate on a checkout instead, install the local directory (pnpm links it, so
edits apply on reload):

```bash
dsh plugin --profile web add /path/to/dsh-web-search-opencode
```

The bundle patch does two things:

1. inserts the `web-search-opencode` row;
2. restates the `web` row with `searchProvider: opencode`.

The pin matters: without it, a profile whose shipped `web-search-deepseek` row is
also usable (a real `DEEPSEEK_API_KEY` is present) would register two usable
search providers and every search would fail with `WEB_PROVIDER_AMBIGUOUS`.

## Configure

Defaults need no configuration. Override the row's `config` in the profile's
`cordis.patch.yml` (Settings → Plugins), or set the environment variable:

| Field                  | Environment variable            | Default    | Meaning                                                     |
| ---------------------- | ------------------------------- | ---------- | ----------------------------------------------------------- |
| `provider`             | `OPENCODE_WEBSEARCH_PROVIDER`   | `auto`     | `auto` (per-query split with failover) \| `exa` \| `parallel` |
| `exaApiKey`            | `EXA_API_KEY`                   | empty      | appended as `?exaApiKey=`, as opencode does                  |
| `parallelApiKey`       | `PARALLEL_API_KEY`              | empty      | sent as `Authorization: Bearer`                              |
| `numResults`           | —                               | `8`        | results requested from the backend                           |
| `searchType`           | —                               | `auto`     | Exa retrieval mode: `auto` \| `fast` \| `deep`               |
| `livecrawl`            | —                               | `fallback` | Exa live-crawl policy: `fallback` \| `preferred`             |
| `contextMaxCharacters` | —                               | `10000`    | Exa per-result context budget                                |
| `modelName`            | —                               | unset      | forwarded to Parallel as `model_name`                        |
| `timeoutMs`            | —                               | `25000`    | per-request budget, as opencode uses                         |

### Who owns the search selection

Any plugin that registers a search provider can also claim the seam's selection.
`@mars-sea/dsh-commandcode-provider` does exactly that: its **"Serve dsh web
search with Command Code"** toggle (`webSearch`, on by default) overwrites
`searchProviderId` at activation, so the model-facing `web_search` goes to
Command Code's plan-backed endpoint — and fails with its own
`HTTP 429 RATE_LIMITED` once that plan's weekly window is spent, even though a
keyless backend is registered and usable.

To hand the selection to this plugin, set `webSearch: false` on that row:

```yaml
- id: llm-commandcode
  name: "@mars-sea/dsh-commandcode-provider"
  config:
    webSearch: false
```

With `false` the plugin leaves the selection alone at boot, so this bundle's
`searchProvider: opencode` pin survives. The toggle takes effect on the next
search, no restart required.

## Develop

```bash
npm test          # node --test, fetch stubbed, no network, no dependencies
npm run smoke     # live search against both real endpoints (network required)
```

```
dsh-web-search-opencode/
├── package.json          # dsh.bundle.patch + locale/icon exports
├── cordis.patch.yml      # bundle layer: insert the row, pin web.searchProvider
├── index.js              # cordis plugin: name / inject / Config / apply
├── lib/
│   ├── provider.js       # OpenCodeSearchProvider, MCP protocol, parsers, failover
│   └── types.js          # JSDoc wire + seam vocabulary
├── locale/{en,zh}.json   # plugin-inventory display metadata
├── icon.svg              # plugin-inventory artwork
├── tests/provider.test.js
└── scripts/smoke.mjs
```

## Acknowledgements

The MCP wire protocol replication and the Exa/Parallel result parsers in
[lib/provider.js](lib/provider.js) are derived from
[FANXING-0710/dsh-web-search-opencode](https://github.com/FANXING-0710/dsh-web-search-opencode),
which declares the MIT license in its `package.json` and `README.md` (it ships
no `LICENSE` file). This implementation adds quota-aware failover across both
backends, own-line URL filtering for citations, and a dependency-free package
layout. See [NOTICE](NOTICE).

## License

MIT

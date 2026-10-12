/**
 * The OpenCode-style search provider for the DeepSeek Harness `ctx.web` seam.
 *
 * opencode (sst/opencode) never routes web search through its own model gateway:
 * the client posts a JSON-RPC 2.0 `tools/call` frame straight to a
 * provider-hosted MCP endpoint. Two backends exist, and this module speaks to
 * both with the same arguments opencode sends:
 *
 * | backend  | endpoint                          | tool name        |
 * | -------- | --------------------------------- | ---------------- |
 * | Exa      | `https://mcp.exa.ai/mcp`          | `web_search_exa` |
 * | Parallel | `https://search.parallel.ai/mcp`  | `web_search`     |
 *
 * Both are usable without an API key, which is the point: a session driven by an
 * `opencode-go` key (or any other non-DeepSeek route) gets a working `web_search`
 * tool without a DeepSeek official API key.
 *
 * Beyond replicating that wire protocol, this provider adds what the raw
 * behavior lacks:
 *
 * - **failover** — Exa's anonymous endpoint answers HTTP 200 with a
 *   rate-limit notice instead of results; that notice is detected and the
 *   sibling backend answers the query instead of the model seeing a wall of
 *   boilerplate;
 * - **structured sources** — Parallel's JSON layout, Exa's `---`-separated
 *   block layout, and a generic line scanner are all parsed so the seam's
 *   citation list is populated rather than empty;
 * - **exact cancellation semantics** — the caller's `AbortSignal` and the
 *   request budget stay distinguishable, so a cancelled search is never
 *   reported as a provider failure.
 *
 * @module dsh-web-search-opencode/provider
 */

/** Stable id this provider registers under (`ctx.web.registerSearchProvider`). */
export const OPENCODE_PROVIDER_ID = 'opencode'

/** Exa MCP endpoint. An API key is appended as `?exaApiKey=`, exactly as opencode does. */
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'

/** Parallel MCP endpoint. */
export const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp'

/** Per-request budget opencode applies to both backends. */
export const MCP_TIMEOUT_MS = 25_000

/** opencode's default result count. */
export const DEFAULT_NUM_RESULTS = 8

/** Exa retrieval mode. */
export const DEFAULT_SEARCH_TYPE = 'auto'

/** Exa live-crawl policy. */
export const DEFAULT_LIVECRAWL = 'fallback'

/** Exa per-result context budget. */
export const DEFAULT_CONTEXT_MAX_CHARS = 10_000

/** Hard ceiling on the count sent to a backend (Exa rejects large counts). */
export const MAX_NUM_RESULTS = 20

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.2.1 (dsh-web-search-opencode)'

/** Machine-routable error code for every provider-side failure. */
const PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'

/** Machine-routable error code for caller cancellation. */
const ABORTED_ERROR = 'WEB_ABORTED'

/** URLs end at whitespace, quotes, or bracket/paren punctuation. */
const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/gu

/**
 * A URL that can plausibly cite a search result: no query string, no fragment.
 * Provider *instructions* embed configured endpoints (`.../mcp?exaApiKey=...`)
 * and no real result cites those, so excluding them keeps a notice from being
 * reported to the model as a source.
 */
const SOURCE_URL_RE = /https?:\/\/[^\s<>()"'`\]?#]+/gu

/**
 * The search endpoints themselves. A notice or an error message cites these as
 * instructions ("update the MCP URL to …"), never as a result, so they are never
 * reported as a source.
 */
const INFRA_URL_RE = /mcp\.exa\.ai|search\.parallel\.ai/iu

/**
 * Whether a scanned URL is a citeable result rather than provider plumbing.
 *
 * Both search layouts put a source URL alone on its line (`URL: …`, or the
 * `url` member of a JSON result), while a notice or an error message writes its
 * endpoints into prose ("create an API key at https://…"). Requiring the URL to
 * occupy its own line is what keeps instructions out of the citation list.
 *
 * @param {string} url - a candidate URL.
 * @param {string} line - the line the URL was found on, trimmed.
 * @returns {boolean} true when it can be a source.
 */
function isCiteableUrl(url, line) {
  return line === url && URL.canParse(url) && !INFRA_URL_RE.test(url)
}

/** Zero-width and BOM characters providers emit around titles. */
const ZWSP_RE = /[\u200B-\u200D\uFEFF]/gu

/** Ellipsis markers Exa splices between highlight fragments. */
const ELLIPSIS_RE = /^\.{3,}$/u

/**
 * Text that means "this backend refused to serve the query" even though the HTTP
 * status was 200. Exa's anonymous endpoint answers this way once its free quota
 * is spent, and it is the reason failover exists.
 */
const LIMIT_WORD_RE = /rate limit|rate-limit|quota|too many requests/iu

/**
 * Refusal language: a notice names a limit and then tells the caller how to get
 * around it, which is what separates it from a real answer that merely discusses
 * rate limiting.
 */
const LIMIT_REFUSAL_RE = /create (?:your own )?(?:\w+ )?api key|upgrade|to continue using|sign in|subscribe/iu

/**
 * The error class the seam routes on. `@deepseek-ai/dsh-web` exports `WebError`
 * (a `HarnessError` with a machine-routable `code`), but a profile-installed
 * bundle cannot always resolve harness internals, so the class is adopted at
 * activation time and this structural stand-in is used when it is unavailable.
 * `dsh-tool-web` reads `code`, which both forms carry.
 */
export class SearchProviderError extends Error {
  /**
   * @param {string} message - human-readable detail, already redacted.
   * @param {string} code - machine-routable code.
   * @param {{ cause?: unknown, quotaExceeded?: boolean }} [options] - chained cause,
   * plus the flag that lets the caller fail over on an exhausted quota.
   */
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
    if (options?.quotaExceeded === true) this.quotaExceeded = true
  }
}

/**
 * Resolve the backend for one query.
 *
 * An explicit `exa`/`parallel` always wins. `auto` picks deterministically from
 * the query text, so a retry of the same query does not bounce between backends
 * (which would defeat both caching and failover), and the two backends share the
 * load roughly evenly across a session.
 *
 * @param {'auto' | 'exa' | 'parallel'} configured - configured mode.
 * @param {string} query - the search query.
 * @returns {'exa' | 'parallel'} the backend to try first.
 */
export function resolveProvider(configured, query) {
  if (configured === 'exa' || configured === 'parallel') return configured
  let hash = 0
  for (const ch of query) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) | 0
  return Math.abs(hash) % 2 === 0 ? 'exa' : 'parallel'
}

/**
 * The other backend, used when the first one cannot serve the query.
 *
 * @param {'exa' | 'parallel'} provider - the backend that failed.
 * @returns {'exa' | 'parallel'} the fallback backend.
 */
export function siblingProvider(provider) {
  return provider === 'exa' ? 'parallel' : 'exa'
}

/**
 * Exa's endpoint, with an optional API key appended as a query parameter.
 *
 * @param {string | undefined} apiKey - the key, if any.
 * @returns {string} the endpoint URL.
 */
export function exaEndpoint(apiKey) {
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}`
  }
  return EXA_MCP_URL
}

/**
 * Clamp a requested result count to what a backend accepts.
 *
 * @param {number | undefined} requested - the caller's `maxResults`, if any.
 * @param {number} fallback - the configured default.
 * @returns {number} an integer in `[1, MAX_NUM_RESULTS]`.
 */
export function clampNumResults(requested, fallback) {
  const value = typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
    ? Math.floor(requested)
    : fallback
  return Math.min(Math.max(value, 1), MAX_NUM_RESULTS)
}

/**
 * Arguments for Exa's `web_search_exa` tool.
 *
 * @param {string} query - the search query.
 * @param {number} numResults - clamped result count.
 * @param {import('./types.js').ProviderOptions} options - resolved options.
 * @returns {import('./types.js').ExaSearchArgs} the tool arguments.
 */
export function buildExaArgs(query, numResults, options) {
  return {
    query,
    type: options.searchType,
    numResults,
    livecrawl: options.livecrawl,
    contextMaxCharacters: options.contextMaxCharacters,
  }
}

/**
 * Arguments for Parallel's `web_search` tool.
 *
 * @param {string} query - the search query.
 * @param {number} numResults - clamped result count.
 * @param {import('./types.js').ProviderOptions} options - resolved options.
 * @returns {import('./types.js').ParallelSearchArgs} the tool arguments.
 */
export function buildParallelArgs(query, numResults, options) {
  /** @type {import('./types.js').ParallelSearchArgs} */
  const args = {
    objective: query,
    search_queries: [query],
    max_results: numResults,
  }
  if (options.modelName !== undefined && options.modelName.length > 0) {
    args.model_name = options.modelName
  }
  return args
}

/**
 * Build the JSON-RPC `tools/call` frame opencode posts to a backend.
 *
 * @param {'exa' | 'parallel'} provider - the backend.
 * @param {string} query - the search query.
 * @param {number} numResults - clamped result count.
 * @param {import('./types.js').ProviderOptions} options - resolved options.
 * @returns {import('./types.js').McpJsonRpcRequest} the request body.
 */
export function buildRequestPayload(provider, query, numResults, options) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: provider === 'exa'
      ? { name: 'web_search_exa', arguments: buildExaArgs(query, numResults, options) }
      : { name: 'web_search', arguments: buildParallelArgs(query, numResults, options) },
  }
}

/**
 * Request headers. Both backends accept either a direct JSON body or an SSE
 * stream, and the same `accept` value opencode sends covers both.
 *
 * @param {'exa' | 'parallel'} provider - the backend.
 * @param {import('./types.js').ProviderOptions} options - resolved options.
 * @returns {Record<string, string>} the headers.
 */
export function buildHeaders(provider, options) {
  /** @type {Record<string, string>} */
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  }
  if (provider === 'parallel' && options.parallelApiKey.length > 0) {
    headers.authorization = `Bearer ${options.parallelApiKey}`
  }
  return headers
}

/**
 * Whether a response body is a quota/limit notice rather than search results.
 *
 * The anonymous Exa endpoint answers a spent quota with HTTP 200 and a notice
 * instead of results, which would otherwise be handed to the model as if it were
 * an answer. A notice is short, carries no citeable URL, and names a limit; a
 * real answer that merely discusses rate limits is long and cites sources.
 *
 * @param {string} text - the extracted MCP text content.
 * @returns {boolean} true when the backend declined to serve the query.
 */
export function looksLikeQuotaNotice(text) {
  if (text.length > 600) return false
  if (!LIMIT_WORD_RE.test(text)) return false
  if (!LIMIT_REFUSAL_RE.test(text)) return false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    SOURCE_URL_RE.lastIndex = 0
    const match = SOURCE_URL_RE.exec(trimmed)
    if (match !== null && isCiteableUrl(match[0], trimmed)) return false
  }
  // No line cites a source, so this short, limit-naming text is a refusal to
  // serve the query — the caller should fail over rather than hand the notice to
  // the model as if it were an answer.
  return true
}

/**
 * True when a line is itself a URL or a URL label, so it cannot be a title or
 * snippet for the neighbouring line.
 *
 * @param {string} line - one trimmed line.
 * @returns {boolean} true when the line carries a URL.
 */
function looksLikeUrlLine(line) {
  const lower = line.toLowerCase()
  if (lower.startsWith('url:') || lower.startsWith('link:') || lower.startsWith('source:')) return true
  URL_RE.lastIndex = 0
  return URL_RE.test(line)
}

/**
 * Strip list markers, numbering, and leading labels from a title line.
 *
 * @param {string} line - one trimmed line.
 * @returns {string} the cleaned title.
 */
function cleanTitle(line) {
  return line
    .replace(/^\s*(?:\d+[.)]?|[-*•])\s*/u, '')
    .replace(/^title:\s*/iu, '')
    .replace(ZWSP_RE, '')
    .trim()
}

/**
 * Strip leading labels from a snippet line.
 *
 * @param {string} line - one trimmed line.
 * @returns {string} the cleaned snippet.
 */
function cleanSnippet(line) {
  return line
    .replace(/^(?:content|snippet|excerpt|text):\s*/iu, '')
    .replace(/^#{1,6}\s*/u, '')
    .trim()
}

/**
 * Parse one Exa-layout block (`Title:` / `URL:` / `Published:` / `Author:` /
 * `Highlights:`), taking the first meaningful highlight as the snippet.
 *
 * @param {string} block - one block of MCP output.
 * @returns {import('./types.js').WebSearchSource | undefined} the source, or
 * `undefined` when the block carries no URL.
 */
export function parseExaBlock(block) {
  /** @type {string | undefined} */ let title
  /** @type {string | undefined} */ let url
  /** @type {string | undefined} */ let snippet
  /** @type {string | undefined} */ let publishedAt
  let inHighlights = false
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('Title:')) {
      const value = cleanTitle(trimmed.slice('Title:'.length))
      if (value.length > 0) title = value
      continue
    }
    if (trimmed.startsWith('URL:')) {
      url = trimmed.slice('URL:'.length).trim()
      continue
    }
    if (trimmed.startsWith('Published:')) {
      const value = trimmed.slice('Published:'.length).trim()
      if (value.length > 0) publishedAt = value
      continue
    }
    if (trimmed.startsWith('Author:')) continue
    if (trimmed.startsWith('Highlights:')) {
      inHighlights = true
      continue
    }
    if (inHighlights && snippet === undefined) {
      const candidate = cleanSnippet(trimmed)
      if (candidate.length > 0 && !ELLIPSIS_RE.test(candidate) && candidate !== title) {
        snippet = candidate.slice(0, 200)
      }
    }
  }
  if (url === undefined || !URL.canParse(url) || INFRA_URL_RE.test(url)) return undefined
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  }
}

/**
 * Fallback scanner for text that uses neither provider's layout: every line
 * carrying a URL takes the previous line as its title and the next as its
 * snippet. Duplicates collapse to the first occurrence.
 *
 * @param {string} text - the backend's full output.
 * @returns {import('./types.js').WebSearchSource[]} normalized sources.
 */
export function extractSourcesByLines(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  /** @type {Set<string>} */ const seen = new Set()
  /** @type {import('./types.js').WebSearchSource[]} */ const sources = []
  for (let i = 0; i < lines.length; i++) {
    SOURCE_URL_RE.lastIndex = 0
    for (const match of lines[i].matchAll(SOURCE_URL_RE)) {
      const url = match[0].replace(/[.,;:!?)\]]+$/u, '')
      if (seen.has(url) || !isCiteableUrl(url, lines[i])) continue
      seen.add(url)
      const prev = i > 0 ? lines[i - 1] : undefined
      const next = i + 1 < lines.length ? lines[i + 1] : undefined
      const title = prev !== undefined && !looksLikeUrlLine(prev) ? cleanTitle(prev) : undefined
      const snippet = next !== undefined && !looksLikeUrlLine(next) ? cleanSnippet(next) : undefined
      sources.push({
        url,
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        ...(snippet !== undefined && snippet.length > 0 ? { snippet: snippet.slice(0, 200) } : {}),
      })
    }
  }
  return sources
}

/**
 * Parse Parallel's layout: a JSON document with `results[]` entries of
 * `{url, title, publish_date, excerpts[]}`. The first non-blank excerpt becomes
 * the snippet.
 *
 * @param {string} text - the backend's full output.
 * @returns {import('./types.js').WebSearchSource[] | undefined} normalized
 * sources, or `undefined` when the text is not this layout.
 */
export function parseParallelJson(text) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const envelope = /** @type {{ results?: unknown }} */ (parsed)
  if (!Array.isArray(envelope.results)) return undefined
  /** @type {Set<string>} */ const seen = new Set()
  /** @type {import('./types.js').WebSearchSource[]} */ const sources = []
  for (const raw of envelope.results) {
    if (raw === null || typeof raw !== 'object') continue
    const item = /** @type {import('./types.js').ParallelResultItem} */ (raw)
    if (typeof item.url !== 'string' || item.url.length === 0) continue
    if (seen.has(item.url) || !URL.canParse(item.url) || INFRA_URL_RE.test(item.url)) continue
    seen.add(item.url)
    const title = typeof item.title === 'string' ? item.title.replace(ZWSP_RE, '').trim() : undefined
    const snippet = Array.isArray(item.excerpts)
      ? item.excerpts.find((excerpt) => typeof excerpt === 'string' && excerpt.trim().length > 0)
      : undefined
    const publishedAt = typeof item.publish_date === 'string' && item.publish_date.length > 0
      ? item.publish_date
      : undefined
    sources.push({
      url: item.url,
      ...(title !== undefined && title.length > 0 ? { title } : {}),
      ...(snippet !== undefined ? { snippet: snippet.trim().slice(0, 200) } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    })
  }
  return sources
}

/**
 * Extract structured sources from a backend's text blob: Parallel's JSON layout
 * first, then `---`-separated Exa blocks, then the line scanner. `content` keeps
 * the full text either way, so an imperfect scan never loses information.
 *
 * @param {string} text - the backend's full output.
 * @returns {import('./types.js').WebSearchSource[]} normalized sources.
 */
export function extractSources(text) {
  const fromJson = parseParallelJson(text)
  if (fromJson !== undefined && fromJson.length > 0) return fromJson

  /** @type {Set<string>} */ const seen = new Set()
  /** @type {import('./types.js').WebSearchSource[]} */ const sources = []
  for (const block of text.split(/\r?\n(?:-{3,}|\*{3,})\r?\n/u)) {
    const source = parseExaBlock(block)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  if (sources.length > 0) return sources
  return extractSourcesByLines(text)
}

/**
 * Map a backend's text blob onto the seam's normalized result.
 *
 * The full blob is kept as `content` because it is what the model reads; the
 * seam owns the final `maxResults` truncation of `sources`, so `truncated` is
 * always false here.
 *
 * @param {string} text - the MCP text content.
 * @returns {import('./types.js').WebSearchResult} the normalized result.
 */
export function mapTextToResult(text) {
  return { content: text, sources: extractSources(text), truncated: false }
}

/**
 * Parse one JSON payload of an MCP response.
 *
 * @param {string} line - a whole body or one SSE `data:` frame.
 * @param {import('./types.js').SearchErrorConstructor} ErrorClass - error class to throw.
 * @returns {string | undefined} the text content, or `undefined` when this frame
 * carries none.
 * @throws {SearchProviderError} on a JSON-RPC `error` member.
 */
export function parseMcpPayload(line, ErrorClass) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const envelope = /** @type {import('./types.js').McpCallEnvelope} */ (parsed)
  if (envelope.error !== undefined) {
    const detail = typeof envelope.error === 'object' && envelope.error !== null
      ? envelope.error.message
      : envelope.error
    throw new ErrorClass(
      typeof detail === 'string' && detail.length > 0 ? detail : 'MCP search error',
      PROVIDER_ERROR,
    )
  }
  const content = envelope.result !== undefined && Array.isArray(envelope.result.content)
    ? envelope.result.content
    : undefined
  if (content === undefined) return undefined
  const item = content.find((entry) => entry !== null && typeof entry.text === 'string' && entry.text.length > 0)
  return item !== undefined ? item.text : undefined
}

/**
 * Extract the text content of an MCP HTTP response body: a direct JSON body
 * first, then SSE frames (`data: ` lines), mirroring opencode's parser.
 *
 * @param {string} body - the raw response text.
 * @param {import('./types.js').SearchErrorConstructor} ErrorClass - error class to throw.
 * @returns {string | undefined} the first text content found.
 * @throws {SearchProviderError} when a JSON-RPC error member is present.
 */
export function parseMcpResponse(body, ErrorClass) {
  const trimmed = body.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith('{')) {
    const direct = parseMcpPayload(trimmed, ErrorClass)
    if (direct !== undefined) return direct
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = parseMcpPayload(line.slice('data:'.length).trim(), ErrorClass)
    if (data !== undefined) return data
  }
  return undefined
}

/**
 * Pull the human-readable detail out of an HTTP error body, which may be JSON
 * (`{error: {message}}`), a JSON-RPC error frame, or plain text.
 *
 * @param {string} body - the raw response body.
 * @returns {string} the detail, or an empty string when there is none.
 */
export function errorDetail(body) {
  const trimmed = body.trim()
  if (trimmed.length === 0) return ''
  if (trimmed.startsWith('{')) {
    try {
      const parsed = /** @type {{ error?: { message?: string } | string, message?: string }} */ (JSON.parse(trimmed))
      const detail = parsed?.error !== undefined && typeof parsed.error === 'object' && parsed.error !== null
        ? parsed.error.message
        : (parsed?.error ?? parsed?.message)
      if (typeof detail === 'string' && detail.length > 0) return detail
    } catch {
      // Not JSON after all; fall through to the plain-text form.
    }
  }
  return trimmed.replace(/\s+/gu, ' ').slice(0, 300)
}

/** The OpenCode-style search provider registered into `ctx.web`. */
export class OpenCodeSearchProvider {
  /** @type {import('./types.js').ProviderOptions} */
  #options

  /** @type {import('./types.js').SearchErrorConstructor} */
  #ErrorClass

  /**
   * @param {import('./types.js').ProviderOptions} options - fully defaulted options.
   * @param {{ errorClass?: import('./types.js').SearchErrorConstructor }} [deps] - the harness's
   * `WebError` class when it could be resolved, for exact error taxonomy.
   */
  constructor(options, deps) {
    this.#options = options
    this.#ErrorClass = deps?.errorClass ?? SearchProviderError
    this.id = OPENCODE_PROVIDER_ID
  }

  /**
   * Cheap local usability check — never a network call. Both backends work
   * keyless, so this only rejects a configuration that cannot be sent.
   *
   * @returns {boolean} whether the configured options are coherent.
   */
  available() {
    const o = this.#options
    return (o.provider === 'auto' || o.provider === 'exa' || o.provider === 'parallel')
      && Number.isInteger(o.numResults) && o.numResults >= 1
      && Number.isInteger(o.timeoutMs) && o.timeoutMs >= 1
      && (o.searchType === 'auto' || o.searchType === 'fast' || o.searchType === 'deep')
      && (o.livecrawl === 'fallback' || o.livecrawl === 'preferred')
      && Number.isInteger(o.contextMaxCharacters) && o.contextMaxCharacters >= 1
  }

  /**
   * Run one search exactly as opencode does: a JSON-RPC `tools/call` frame to
   * the selected MCP endpoint inside the configured budget.
   *
   * When the first backend answers with a quota notice or a transport failure,
   * the sibling backend gets one attempt with the same budget. A caller
   * cancellation is never retried and never reported as a provider failure.
   *
   * @param {import('./types.js').WebSearchRequest} request - the query and bound.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<import('./types.js').WebSearchResult>} the normalized result.
   * @throws {SearchProviderError} on transport, protocol, or provider failure.
   */
  async search(request, signal) {
    const query = typeof request.query === 'string' ? request.query.trim() : ''
    if (query.length === 0) {
      throw new this.#ErrorClass('query must be a non-empty string', PROVIDER_ERROR)
    }

    const numResults = clampNumResults(request.maxResults, this.#options.numResults)
    const first = resolveProvider(this.#options.provider, query)
    const auto = this.#options.provider === 'auto'
    /** @type {{ provider: 'exa' | 'parallel', text: string } | undefined} */ let answer
    /** @type {unknown} */ let lastFailure
    /** @type {string} */ let lastMessage = ''
    let quotaSeen = false

    for (const provider of [first, siblingProvider(first)]) {
      // A pinned backend only yields to its sibling when its own quota is spent:
      // an exhausted quota is not a reason to fail a search, while every other
      // failure stays honest in pinned mode.
      if (provider !== first && !auto && !quotaSeen) break
      try {
        const text = await this.#callBackend(provider, query, numResults, signal)
        if (looksLikeQuotaNotice(text)) {
          quotaSeen = true
          const refusal = new this.#ErrorClass(`${provider} declined the query (quota or rate limit)`, PROVIDER_ERROR, { quotaExceeded: true })
          lastFailure = refusal
          lastMessage = refusal.message
          continue
        }
        answer = { provider, text }
        break
      } catch (error) {
        if (isAbortError(error) || isAborted(signal)) throw this.#aborted(signal, error)
        lastFailure = error
        lastMessage = error instanceof Error ? error.message : String(error)
        quotaSeen = isQuotaExceeded(error)
      }
    }

    if (answer === undefined) {
      // A single-candidate search (a pinned backend with an ordinary failure)
      // reports that backend's own error unchanged, so the seam and the model see
      // the real provider failure instead of a summary of one.
      if (lastFailure instanceof Error && !auto && !quotaSeen) throw lastFailure
      throw new this.#ErrorClass(
        `no OpenCode search backend could answer "${query}": ${lastMessage}`,
        PROVIDER_ERROR,
        lastFailure === undefined ? undefined : { cause: lastFailure },
      )
    }
    return mapTextToResult(answer.text)
  }

  /**
   * One HTTP round trip to one backend.
   *
   * @param {'exa' | 'parallel'} provider - the backend.
   * @param {string} query - the search query.
   * @param {number} numResults - clamped result count.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<string>} the backend's text content.
   * @throws {SearchProviderError} on transport, HTTP, or protocol failure.
   */
  async #callBackend(provider, query, numResults, signal) {
    const o = this.#options
    const url = provider === 'exa' ? exaEndpoint(o.exaApiKey) : PARALLEL_MCP_URL
    const body = JSON.stringify(buildRequestPayload(provider, query, numResults, o))

    // One controller merges the caller's cancellation with the request budget,
    // so the two stay distinguishable in the error that comes out. The flag is a
    // number so control-flow analysis cannot narrow it away after the closure
    // assigns to it.
    const controller = new AbortController()
    /** @type {0 | 1} */ let timedOut = 0
    const timer = setTimeout(() => {
      timedOut = 1
      controller.abort()
    }, o.timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted === true) {
      clearTimeout(timer)
      throw this.#aborted(signal)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    /** @type {Response} */
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(provider, o),
        body,
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) {
        throw new this.#ErrorClass(`${provider} search timed out after ${o.timeoutMs}ms`, PROVIDER_ERROR)
      }
      if (isAborted(signal) || isAbortError(error)) throw this.#aborted(signal, error)
      throw new this.#ErrorClass(`${provider} search request failed: ${String(error)}`, PROVIDER_ERROR, { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    if (!response.ok) {
      // A spent quota is reported as HTTP 429 (or 403) with a notice body rather
      // than as a result, so read the body before deciding: an exhausted backend
      // must fail over, not fail the search.
      let message = `${provider} API error (HTTP ${response.status})`
      let quotaExceeded = false
      let body = ''
      try {
        body = await response.text()
      } catch {
        // A body that cannot be read leaves the status code as the whole detail.
      }
      if (body.length > 0) {
        const detail = errorDetail(body)
        if (detail.length > 0) message = `${message}: ${detail}`
        quotaExceeded = (response.status === 429 || response.status === 403) && looksLikeQuotaNotice(body)
      } else {
        quotaExceeded = response.status === 429
      }
      throw new this.#ErrorClass(message, PROVIDER_ERROR, { quotaExceeded })
    }

    try {
      const text = parseMcpResponse(await response.text(), this.#ErrorClass)
      if (text === undefined) {
        throw new this.#ErrorClass(`${provider} returned no search results for: ${query}`, PROVIDER_ERROR)
      }
      return text
    } catch (error) {
      if (isAborted(signal) || isAbortError(error)) throw this.#aborted(signal, error)
      if (error instanceof this.#ErrorClass) throw error
      throw new this.#ErrorClass(
        `${provider} returned an unprocessable response body: ${String(error)}`,
        PROVIDER_ERROR,
        { cause: error },
      )
    }
  }

  /**
   * The seam's stable cancellation error, retaining the caller's reason.
   *
   * @param {AbortSignal} [signal] - the caller's signal.
   * @param {unknown} [fallback] - a transport error to chain when the signal is silent.
   * @returns {import('./types.js').SearchErrorConstructor extends new (...args: never[]) => infer R ? R : never} the cancellation error.
   */
  #aborted(signal, fallback) {
    return new this.#ErrorClass('web search aborted', ABORTED_ERROR, {
      cause: signal?.aborted === true ? signal.reason : fallback,
    })
  }
}

/**
 * True for a fetch or `AbortSignal` abort.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} whether it is an abort. Explicitly `boolean` so the caller's
 * control-flow analysis does not narrow the caught value to `false | undefined`.
 */
export function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Whether the caller's signal already fired. A function (rather than a direct
 * property check) so control-flow analysis cannot stale-narrow it after the
 * pre-flight abort check.
 *
 * @param {AbortSignal} [signal] - the caller's signal.
 * @returns {boolean} whether it fired.
 */
export function isAborted(signal) {
  return signal?.aborted === true
}

/**
 * Whether a failure means "this backend's quota is spent", which the caller may
 * answer with the sibling backend instead of surfacing the failure.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} whether the failure is an exhausted quota.
 */
export function isQuotaExceeded(error) {
  return typeof error === 'object' && error !== null && /** @type {{ quotaExceeded?: boolean }} */ (error).quotaExceeded === true
}

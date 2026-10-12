/**
 * Unit tests for the OpenCode-style search provider.
 *
 * Every test stubs `globalThis.fetch`, so the suite never touches the network.
 * Run with `npm test` (plain `node --test`, no build step, no dependencies).
 *
 * @module dsh-web-search-opencode/tests/provider
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_LIVECRAWL,
  DEFAULT_NUM_RESULTS,
  DEFAULT_SEARCH_TYPE,
  MCP_TIMEOUT_MS,
  OPENCODE_PROVIDER_ID,
  OpenCodeSearchProvider,
  SearchProviderError,
  buildRequestPayload,
  clampNumResults,
  exaEndpoint,
  extractSources,
  looksLikeQuotaNotice,
  mapTextToResult,
  parseMcpResponse,
  resolveProvider,
  siblingProvider,
} from '../lib/provider.js'
import { Config } from '../index.js'

/** The Exa MCP text layout: `---`-separated blocks with `Title:`/`URL:`/`Highlights:`. */
const EXA_TEXT = [
  'Title: DeepSeek Harness',
  'URL: https://www.deepseek.com/en/harness/',
  'Published: 2026-09-20T00:00:00.000Z',
  'Author: DeepSeek',
  'Highlights:',
  'Harness turns a model into a working agent runtime.',
  '...',
  'Second highlight fragment.',
  '',
  '---',
  '',
  'Title: opencode',
  'URL: https://opencode.ai/',
  'Highlights:',
  'The open source AI coding agent.',
].join('\n')

/** The Parallel MCP text layout: a JSON document with `results[]`. */
const PARALLEL_TEXT = JSON.stringify({
  search_id: 'search_test',
  results: [
    {
      url: 'https://www.deepseek.com/en/harness/',
      title: 'DeepSeek Harness',
      publish_date: '2026-09-20',
      excerpts: ['Harness is a harness.', 'Second excerpt.'],
    },
    { url: 'https://opencode.ai/', title: 'opencode', publish_date: null, excerpts: [] },
  ],
})

/** Exa's anonymous-endpoint answer once its free quota is spent: HTTP 200, no results. */
const EXA_QUOTA_NOTICE = "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys , and then update Exa MCP URL to this https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY"

/** Wrap text as an SSE MCP response, the way both endpoints answer. */
function sse(text) {
  return `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text }] }, jsonrpc: '2.0', id: 1 })}\n\n`
}

/** Wrap text as a direct JSON MCP response. */
function direct(text) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })
}

/** Options with everything defaulted, as `apply` would produce. */
function options(overrides = {}) {
  return {
    provider: 'exa',
    exaApiKey: '',
    parallelApiKey: '',
    numResults: DEFAULT_NUM_RESULTS,
    searchType: DEFAULT_SEARCH_TYPE,
    livecrawl: DEFAULT_LIVECRAWL,
    contextMaxCharacters: DEFAULT_CONTEXT_MAX_CHARS,
    timeoutMs: MCP_TIMEOUT_MS,
    ...overrides,
  }
}

/**
 * Install a fetch stub and record every call.
 *
 * @param {(url: string, init: object, index: number) => Promise<Response> | Response} handler - per-call response.
 * @returns {{ calls: Array<{ url: string, init: object }> }} the recorded calls.
 */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const index = calls.length
    calls.push({ url: String(url), init: init ?? {} })
    return handler(String(url), init ?? {}, index)
  }
  return { calls }
}

/** A minimal `Response`-like object; only the members the provider reads. */
function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }
}

afterEach(() => {
  delete globalThis.fetch
})

test('resolveProvider: explicit modes win, auto is stable per query', () => {
  assert.equal(resolveProvider('exa', 'anything'), 'exa')
  assert.equal(resolveProvider('parallel', 'anything'), 'parallel')
  const first = resolveProvider('auto', 'deepseek harness')
  assert.equal(resolveProvider('auto', 'deepseek harness'), first)
  assert.equal(siblingProvider(first) === first, false)
})

test('clampNumResults: respects the caller bound and the backend ceiling', () => {
  assert.equal(clampNumResults(undefined, 8), 8)
  assert.equal(clampNumResults(3, 8), 3)
  assert.equal(clampNumResults(0, 8), 8)
  assert.equal(clampNumResults(-5, 8), 8)
  assert.equal(clampNumResults(1000, 8), 20)
  assert.equal(clampNumResults(4.7, 8), 4)
})

test('exaEndpoint: appends the key as a query parameter only when present', () => {
  assert.equal(exaEndpoint(''), 'https://mcp.exa.ai/mcp')
  assert.equal(exaEndpoint(undefined), 'https://mcp.exa.ai/mcp')
  assert.equal(exaEndpoint('a b'), 'https://mcp.exa.ai/mcp?exaApiKey=a%20b')
})

test('buildRequestPayload: sends the arguments opencode sends', () => {
  const exa = buildRequestPayload('exa', 'q', 4, options())
  assert.equal(exa.method, 'tools/call')
  assert.equal(exa.params.name, 'web_search_exa')
  assert.deepEqual(exa.params.arguments, {
    query: 'q',
    type: 'auto',
    numResults: 4,
    livecrawl: 'fallback',
    contextMaxCharacters: 10_000,
  })

  const parallel = buildRequestPayload('parallel', 'q', 4, options({ modelName: 'opencode-go/deepseek-v4-flash' }))
  assert.equal(parallel.params.name, 'web_search')
  assert.deepEqual(parallel.params.arguments, {
    objective: 'q',
    search_queries: ['q'],
    max_results: 4,
    model_name: 'opencode-go/deepseek-v4-flash',
  })
})

test('parseMcpResponse: reads a direct JSON body and SSE frames alike', () => {
  assert.equal(parseMcpResponse(direct('hello'), SearchProviderError), 'hello')
  assert.equal(parseMcpResponse(sse('world'), SearchProviderError), 'world')
  assert.equal(parseMcpResponse('   ', SearchProviderError), undefined)
  assert.equal(parseMcpResponse('not json at all', SearchProviderError), undefined)
})

test('parseMcpResponse: surfaces a JSON-RPC error member as a WebError', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'bad query' } })
  assert.throws(
    () => parseMcpResponse(body, SearchProviderError),
    (error) => error instanceof SearchProviderError && error.code === 'WEB_PROVIDER_ERROR' && /bad query/u.test(error.message),
  )
})

test('extractSources: parses the Exa block layout', () => {
  const sources = extractSources(EXA_TEXT)
  assert.equal(sources.length, 2)
  assert.deepEqual(sources[0], {
    url: 'https://www.deepseek.com/en/harness/',
    title: 'DeepSeek Harness',
    snippet: 'Harness turns a model into a working agent runtime.',
    publishedAt: '2026-09-20T00:00:00.000Z',
  })
  assert.deepEqual(sources[1], {
    url: 'https://opencode.ai/',
    title: 'opencode',
    snippet: 'The open source AI coding agent.',
  })
})

test('extractSources: parses the Parallel JSON layout and dedupes', () => {
  const sources = extractSources(PARALLEL_TEXT)
  assert.deepEqual(sources, [
    {
      url: 'https://www.deepseek.com/en/harness/',
      title: 'DeepSeek Harness',
      snippet: 'Harness is a harness.',
      publishedAt: '2026-09-20',
    },
    { url: 'https://opencode.ai/', title: 'opencode' },
  ])
})

test('extractSources: falls back to a line scanner for unknown layouts', () => {
  const text = '1. Some title here\nhttps://example.com/a\nA snippet for it.\nhttps://example.com/a\nhttps://example.com/b'
  const sources = extractSources(text)
  assert.deepEqual(sources, [
    { url: 'https://example.com/a', title: 'Some title here', snippet: 'A snippet for it.' },
    { url: 'https://example.com/b' },
  ])
})

test('extractSources: never invents a source for result-free text', () => {
  assert.deepEqual(extractSources(EXA_QUOTA_NOTICE), [])
  assert.deepEqual(extractSources(''), [])
})

test('looksLikeQuotaNotice: distinguishes a notice from a real answer mentioning limits', () => {
  assert.equal(looksLikeQuotaNotice(EXA_QUOTA_NOTICE), true)
  // Exa's notice is the same shape with the link stripped out.
  assert.equal(looksLikeQuotaNotice("You've hit Exa's free MCP rate limit. Create your own Exa API key to continue."), true)
  // A substantive prose answer that discusses rate limits is not a notice.
  assert.equal(
    looksLikeQuotaNotice('Search results: rate limits are documented in the pricing page, and the free tier resets monthly. Providers usually return 429 with a Retry-After header when the quota is exhausted.'),
    false,
  )
  // A short answer that cites a source is a result, not a notice.
  assert.equal(looksLikeQuotaNotice('Rate limit reference\nhttps://example.com/limits'), false)
  assert.equal(looksLikeQuotaNotice(EXA_TEXT), false)
})

test('mapTextToResult: keeps the whole blob as content', () => {
  const result = mapTextToResult(PARALLEL_TEXT)
  assert.equal(result.content, PARALLEL_TEXT)
  assert.equal(result.truncated, false)
  assert.equal(result.sources.length, 2)
})

test('search: Exa SSE response yields content and sources', async () => {
  const { calls } = stubFetch(() => response(sse(EXA_TEXT), { status: 200 }))
  const provider = new OpenCodeSearchProvider(options({ provider: 'exa' }))

  assert.equal(provider.id, OPENCODE_PROVIDER_ID)
  assert.equal(provider.available(), true)

  const result = await provider.search({ query: 'deepseek harness', maxResults: 5 })
  assert.equal(result.content, EXA_TEXT)
  assert.equal(result.sources.length, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://mcp.exa.ai/mcp')
  assert.equal(calls[0].init.headers.accept, 'application/json, text/event-stream')
  assert.equal(calls[0].init.redirect, 'error')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.params.arguments.numResults, 5)
  assert.equal(sent.params.name, 'web_search_exa')
})

test('search: Parallel direct JSON response, with the bearer key when configured', async () => {
  const { calls } = stubFetch(() => response(direct(PARALLEL_TEXT), { status: 200 }))
  const provider = new OpenCodeSearchProvider(options({ provider: 'parallel', parallelApiKey: 'pk-1' }))

  const result = await provider.search({ query: 'opencode' })
  assert.equal(result.sources[0].url, 'https://www.deepseek.com/en/harness/')
  assert.equal(calls[0].url, 'https://search.parallel.ai/mcp')
  assert.equal(calls[0].init.headers.authorization, 'Bearer pk-1')
  assert.equal(JSON.parse(calls[0].init.body).params.arguments.max_results, DEFAULT_NUM_RESULTS)
})

test('search: an Exa quota notice in a 200 body fails over to Parallel', async () => {
  const { calls } = stubFetch((url) => (
    url.includes('mcp.exa.ai') ? response(sse(EXA_QUOTA_NOTICE), { status: 200 }) : response(direct(PARALLEL_TEXT), { status: 200 })
  ))
  const provider = new OpenCodeSearchProvider(options({ provider: 'auto' }))
  const query = findQueryResolvingTo('exa')

  const result = await provider.search({ query })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://mcp.exa.ai/mcp')
  assert.equal(calls[1].url, 'https://search.parallel.ai/mcp')
  assert.equal(result.content, PARALLEL_TEXT)
  assert.equal(result.sources.length, 2)
})

test('search: an HTTP 429 quota body fails over even when Exa is pinned', async () => {
  // This is Exa's real anonymous-endpoint behavior: HTTP 429 with the notice text.
  const { calls } = stubFetch((url) => (
    url.includes('mcp.exa.ai')
      ? response(EXA_QUOTA_NOTICE, { status: 429 })
      : response(direct(PARALLEL_TEXT), { status: 200 })
  ))
  const provider = new OpenCodeSearchProvider(options({ provider: 'exa' }))

  const result = await provider.search({ query: 'deepseek harness' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://search.parallel.ai/mcp')
  assert.equal(result.sources.length, 2)
})

test('search: a non-quota HTTP failure does not fail over when Exa is pinned', async () => {
  const { calls } = stubFetch(() => response(JSON.stringify({ error: { message: 'service unavailable' } }), { status: 503 }))
  const provider = new OpenCodeSearchProvider(options({ provider: 'exa' }))

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => /exa API error \(HTTP 503\): service unavailable/u.test(error.message),
  )
  assert.equal(calls.length, 1)
})

test('search: a pinned backend that is rate limited reports the notice when both backends are', async () => {
  const { calls } = stubFetch((url) => (
    url.includes('mcp.exa.ai')
      ? response(EXA_QUOTA_NOTICE, { status: 429 })
      : response(JSON.stringify({ error: { message: 'parallel quota exhausted' } }), { status: 429 })
  ))
  const provider = new OpenCodeSearchProvider(options({ provider: 'exa' }))

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_ERROR' && /quota or rate limit|429/u.test(error.message),
  )
  assert.equal(calls.length, 2)
})

test('search: HTTP failure fails over in auto mode and reports both backends when both fail', async () => {
  const { calls } = stubFetch(() => response(JSON.stringify({ error: { message: 'service unavailable' } }), { status: 503 }))
  const provider = new OpenCodeSearchProvider(options({ provider: 'auto' }))

  await assert.rejects(
    provider.search({ query: findQueryResolvingTo('exa') }),
    (error) => error instanceof SearchProviderError && /HTTP 503/u.test(error.message) && /service unavailable/u.test(error.message),
  )
  assert.equal(calls.length, 2)
})

test('search: an HTTP error body message is preserved', async () => {
  const { calls } = stubFetch(() => response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 }))
  const provider = new OpenCodeSearchProvider(options({ provider: 'exa' }))

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => /exa API error \(HTTP 429\): slow down/u.test(error.message),
  )
  assert.equal(calls.length, 1)
})

test('search: an empty query is rejected before any request', async () => {
  const { calls } = stubFetch(() => response(sse(EXA_TEXT)))
  const provider = new OpenCodeSearchProvider(options())

  await assert.rejects(provider.search({ query: '   ' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
  assert.equal(calls.length, 0)
})

test('search: a caller abort is WEB_ABORTED and is never retried', async () => {
  const controller = new AbortController()
  let seen
  const { calls } = stubFetch((_url, init) => {
    seen = init.signal
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  })
  const provider = new OpenCodeSearchProvider(options({ provider: 'auto' }))
  const pending = provider.search({ query: 'q' }, controller.signal)
  controller.abort(new Error('user cancelled'))

  await assert.rejects(
    pending,
    (error) => error instanceof SearchProviderError
      && error.code === 'WEB_ABORTED'
      && error.cause instanceof Error
      && error.cause.message === 'user cancelled',
  )
  assert.equal(calls.length, 1)
  assert.equal(seen.aborted, true)
})

test('search: an already-aborted signal short-circuits', async () => {
  const { calls } = stubFetch(() => response(sse(EXA_TEXT)))
  const controller = new AbortController()
  controller.abort()
  const provider = new OpenCodeSearchProvider(options())

  await assert.rejects(provider.search({ query: 'q' }, controller.signal), (error) => error.code === 'WEB_ABORTED')
  assert.equal(calls.length, 0)
})

test('search: the request budget is a provider error, not a cancellation', async () => {
  const { calls } = stubFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
  const provider = new OpenCodeSearchProvider(options({ provider: 'exa', timeoutMs: 20 }))

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_ERROR' && /timed out after 20ms/u.test(error.message),
  )
  assert.equal(calls.length, 1)
})

test('search: an unparseable body is a provider error naming the backend', async () => {
  const { calls } = stubFetch(() => response('<html>not mcp</html>', { status: 200 }))
  const provider = new OpenCodeSearchProvider(options({ provider: 'exa' }))

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_ERROR' && /no search results for: q/u.test(error.message),
  )
  assert.equal(calls.length, 1)
})

test('available: rejects an incoherent configuration without touching the network', () => {
  assert.equal(new OpenCodeSearchProvider(options()).available(), true)
  assert.equal(new OpenCodeSearchProvider(options({ provider: 'nope' })).available(), false)
  assert.equal(new OpenCodeSearchProvider(options({ numResults: 0 })).available(), false)
  assert.equal(new OpenCodeSearchProvider(options({ timeoutMs: 0 })).available(), false)
  assert.equal(new OpenCodeSearchProvider(options({ searchType: 'slow' })).available(), false)
  assert.equal(new OpenCodeSearchProvider(options({ livecrawl: 'never' })).available(), false)
})

test('Config: fills every default and normalizes a raw row', () => {
  const { value, issues } = Config['~standard'].validate({})
  assert.equal(issues, undefined)
  assert.deepEqual(value, {
    provider: 'auto',
    exaApiKey: '',
    parallelApiKey: '',
    numResults: DEFAULT_NUM_RESULTS,
    searchType: DEFAULT_SEARCH_TYPE,
    livecrawl: DEFAULT_LIVECRAWL,
    contextMaxCharacters: DEFAULT_CONTEXT_MAX_CHARS,
    timeoutMs: MCP_TIMEOUT_MS,
  })
})

test('Config: keeps user values, including a model name for Parallel', () => {
  const { value } = Config['~standard'].validate({
    provider: 'parallel',
    numResults: 3,
    timeoutMs: 5000,
    modelName: 'opencode-go/deepseek-v4-flash',
  })
  assert.equal(value.provider, 'parallel')
  assert.equal(value.numResults, 3)
  assert.equal(value.timeoutMs, 5000)
  assert.equal(value.modelName, 'opencode-go/deepseek-v4-flash')
})

test('Config: reports issues for values it cannot send', () => {
  const { issues } = Config['~standard'].validate({ provider: 'bing', numResults: 'many', timeoutMs: 10 })
  assert.equal(Array.isArray(issues), true)
  assert.deepEqual(issues.map((issue) => issue.path[0]).sort(), ['numResults', 'provider', 'timeoutMs'])
})

test('Config: the JSON-Schema projection matches the documented defaults', () => {
  const properties = Config.jsonSchema.properties
  assert.equal(properties.provider.default, 'auto')
  assert.deepEqual(properties.provider.enum, ['auto', 'exa', 'parallel'])
  assert.equal(properties.numResults.default, DEFAULT_NUM_RESULTS)
  assert.equal(properties.timeoutMs.default, MCP_TIMEOUT_MS)
})

/**
 * Find a query string that `resolveProvider('auto', query)` routes to the given
 * backend, so a failover test does not depend on hash luck.
 *
 * @param {'exa' | 'parallel'} target - the desired first backend.
 * @returns {string} a query routed to it.
 */
function findQueryResolvingTo(target) {
  for (let i = 0; i < 1000; i++) {
    const candidate = `query-${i}`
    if (resolveProvider('auto', candidate) === target) return candidate
  }
  throw new Error(`no query routes to ${target}`)
}

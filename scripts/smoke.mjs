/**
 * Live smoke test: run real searches through the provider against the Exa and
 * Parallel MCP endpoints. Network access is required, so this is not part of
 * `npm test`.
 *
 *   node scripts/smoke.mjs            # both backends, one query each
 *   node scripts/smoke.mjs "query"    # a custom query
 *
 * @module dsh-web-search-opencode/scripts/smoke
 */

import {
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_LIVECRAWL,
  DEFAULT_NUM_RESULTS,
  DEFAULT_SEARCH_TYPE,
  MCP_TIMEOUT_MS,
  OpenCodeSearchProvider,
} from '../lib/provider.js'

/** @type {string} */
const query = process.argv[2] ?? 'DeepSeek Harness web search'

/** One provider per backend, plus the failover configuration. */
const cases = [
  ['exa', { provider: 'exa' }],
  ['parallel', { provider: 'parallel' }],
  ['auto (with failover)', { provider: 'auto' }],
]

let failures = 0
for (const [label, overrides] of cases) {
  const provider = new OpenCodeSearchProvider({
    provider: 'auto',
    exaApiKey: process.env.EXA_API_KEY ?? '',
    parallelApiKey: process.env.PARALLEL_API_KEY ?? '',
    numResults: DEFAULT_NUM_RESULTS,
    searchType: DEFAULT_SEARCH_TYPE,
    livecrawl: DEFAULT_LIVECRAWL,
    contextMaxCharacters: DEFAULT_CONTEXT_MAX_CHARS,
    timeoutMs: MCP_TIMEOUT_MS,
    ...overrides,
  })
  const started = Date.now()
  try {
    const result = await provider.search({ query, maxResults: 3 })
    const sources = result.sources.slice(0, 3)
    console.log(`\n=== ${label} — ${Date.now() - started}ms, ${result.sources.length} source(s) ===`)
    console.log(`${(result.content ?? '').slice(0, 300).replace(/\s+/gu, ' ')}…`)
    for (const source of sources) console.log(`  - ${source.title ?? source.url} <${source.url}>`)
  } catch (error) {
    failures += 1
    console.error(`\n=== ${label} — FAILED after ${Date.now() - started}ms ===`)
    console.error(`  ${error.code ?? '?'}: ${error.message}`)
  }
}

console.log(`\n${failures === 0 ? 'all backends answered' : `${failures} backend(s) failed`}`)
process.exitCode = failures === cases.length ? 1 : 0

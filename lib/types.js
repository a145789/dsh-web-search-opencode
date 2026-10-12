/**
 * Wire vocabulary for the OpenCode-style search MCP protocol, plus the shapes
 * the DeepSeek Harness `ctx.web` seam passes in and out.
 *
 * The MCP types mirror what opencode (sst/opencode) sends to and receives from
 * the Exa and Parallel endpoints. The `ctx.web` types are structurally
 * compatible with `@deepseek-ai/dsh-web`; they are declared here so the plugin
 * carries no runtime dependency on harness internals.
 *
 * @module dsh-web-search-opencode/types
 */

/**
 * @typedef {object} McpJsonRpcRequest
 * @property {'2.0'} jsonrpc
 * @property {1} id
 * @property {'tools/call'} method
 * @property {{ name: string, arguments: object }} params
 */

/**
 * @typedef {object} McpTextContent
 * @property {string} type
 * @property {string} text
 */

/**
 * @typedef {object} McpCallEnvelope
 * @property {{ content?: McpTextContent[] }} [result]
 * @property {{ code?: number, message?: string } | string} [error]
 */

/**
 * @typedef {object} ExaSearchArgs
 * @property {string} query
 * @property {'auto' | 'fast' | 'deep'} type
 * @property {number} numResults
 * @property {'fallback' | 'preferred'} livecrawl
 * @property {number} contextMaxCharacters
 */

/**
 * @typedef {object} ParallelSearchArgs
 * @property {string} objective
 * @property {string[]} search_queries
 * @property {number} [max_results]
 * @property {string} [session_id]
 * @property {string} [model_name]
 */

/**
 * @typedef {object} ParallelResultItem
 * @property {string} url
 * @property {string | null} [title]
 * @property {string | null} [publish_date]
 * @property {string[]} [excerpts]
 */

/**
 * @typedef {object} ParallelSearchResponse
 * @property {string} [search_id]
 * @property {ParallelResultItem[]} [results]
 */

/**
 * @typedef {object} WebSearchRequest
 * @property {string} query
 * @property {number} [maxResults]
 */

/**
 * @typedef {object} WebSearchSource
 * @property {string} url
 * @property {string} [title]
 * @property {string} [snippet]
 * @property {string} [publishedAt]
 */

/**
 * @typedef {object} WebSearchResult
 * @property {string} [content]
 * @property {WebSearchSource[]} sources
 * @property {boolean} truncated
 */

/**
 * @typedef {object} WebSearchProvider
 * @property {string} id
 * @property {() => boolean} available
 * @property {(request: WebSearchRequest, signal?: AbortSignal) => Promise<WebSearchResult>} search
 */

/**
 * The error constructor the provider throws with: either the seam's own
 * `WebError` (adopted when the harness package resolves) or the structural
 * stand-in this plugin ships.
 *
 * @typedef {new (message: string, code: string, options?: { cause?: unknown, quotaExceeded?: boolean }) => Error & { code: string, quotaExceeded?: boolean }} SearchErrorConstructor
 */

/**
 * Resolved provider options: every default already filled in by the plugin's
 * `apply`, so the provider itself never reads the environment.
 *
 * @typedef {object} ProviderOptions
 * @property {'auto' | 'exa' | 'parallel'} provider
 * @property {string} exaApiKey
 * @property {string} parallelApiKey
 * @property {number} numResults
 * @property {'auto' | 'fast' | 'deep'} searchType
 * @property {'fallback' | 'preferred'} livecrawl
 * @property {number} contextMaxCharacters
 * @property {string} [modelName]
 * @property {number} timeoutMs
 */

export {}

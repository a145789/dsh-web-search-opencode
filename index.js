/**
 * `dsh-web-search-opencode` — OpenCode-style web search for the DeepSeek
 * Harness `ctx.web` seam.
 *
 * The shipped search provider (`@deepseek-ai/dsh-web-search-deepseek`) speaks
 * the Anthropic-compatible Messages API with the `web_search_20250305` server
 * tool, so it needs a DeepSeek official API key. A session driven by an
 * `opencode-go` key (or any other non-DeepSeek route) therefore gets
 * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` from `web_search`. opencode itself does
 * not have that problem because it runs search client-side against the Exa and
 * Parallel MCP endpoints, which work without a key — this plugin registers that
 * same behavior as a `WebSearchProvider`.
 *
 * Shape of the plugin: a function plugin that registers INTO the seam's provider
 * registry (it does not own the `ctx.web` key, which belongs to
 * `@deepseek-ai/dsh-web`), exactly like the shipped providers do.
 *
 * Two deliberate choices keep it robust in a profile-installed bundle:
 *
 * - **no runtime imports** — a bundle installed into a profile cannot reliably
 *   resolve harness internals (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-web`,
 *   `@deepseek-ai/cordis` all fail to resolve from the profile directory), so
 *   the provider carries its own structurally-compatible error class and the
 *   `Config` export is a plain Standard Schema object, which is exactly what the
 *   loader's `resolveConfig` consumes;
 * - **registration as an effect** — the provider is registered through
 *   `ctx.effect`, so unloading the plugin unregisters it with the seam.
 *
 * @module dsh-web-search-opencode
 */

import {
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_LIVECRAWL,
  DEFAULT_NUM_RESULTS,
  DEFAULT_SEARCH_TYPE,
  MCP_TIMEOUT_MS,
  OPENCODE_PROVIDER_ID,
  OpenCodeSearchProvider,
  SearchProviderError,
  isAbortError,
} from './lib/provider.js'

export {
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_LIVECRAWL,
  DEFAULT_NUM_RESULTS,
  DEFAULT_SEARCH_TYPE,
  EXA_MCP_URL,
  MCP_TIMEOUT_MS,
  MAX_NUM_RESULTS,
  OPENCODE_PROVIDER_ID,
  OpenCodeSearchProvider,
  PARALLEL_MCP_URL,
  SearchProviderError,
  buildExaArgs,
  buildHeaders,
  buildParallelArgs,
  buildRequestPayload,
  clampNumResults,
  extractSources,
  extractSourcesByLines,
  looksLikeQuotaNotice,
  mapTextToResult,
  parseExaBlock,
  parseMcpPayload,
  parseMcpResponse,
  parseParallelJson,
  resolveProvider,
  siblingProvider,
} from './lib/provider.js'

/** Cordis plugin name used by loader diagnostics and the plugin inventory. */
export const name = 'web-search-opencode'

/** The seam this provider registers into. */
export const inject = ['web']

/** Backend ids this plugin accepts. */
const PROVIDER_MODES = ['auto', 'exa', 'parallel']

/** Exa retrieval modes this plugin accepts. */
const SEARCH_TYPES = ['auto', 'fast', 'deep']

/** Exa live-crawl policies this plugin accepts. */
const LIVECRAWLS = ['fallback', 'preferred']

/**
 * One field descriptor for the config schema: an optional field that accepts
 * `undefined` (so an omitted key validates) and otherwise a constrained value.
 *
 * @param {object} spec - the constraint.
 * @param {'string' | 'number' | 'union'} spec.kind - the value kind.
 * @param {string[]} [spec.options] - allowed literals for a union.
 * @param {number} [spec.min] - inclusive minimum for a number.
 * @param {number} [spec.integer] - `1` to require an integer.
 * @param {string} spec.description - field documentation.
 * @param {unknown} [spec.default] - documented default, shown by config editors.
 * @returns {object} the field descriptor.
 */
function field(spec) {
  return {
    kind: spec.kind,
    options: spec.options,
    min: spec.min,
    integer: spec.integer,
    description: spec.description,
    default: spec.default,
  }
}

/**
 * The plugin config, as a Standard Schema (the interface
 * `resolveConfig(runtime, config)` consumes) plus a JSON-Schema projection that
 * config editors read. Every field is optional; `apply` fills environment and
 * constant defaults.
 *
 * Using a plain object instead of a `@deepseek-ai/schemastery` schema is
 * deliberate: schemastery is not resolvable from a profile directory, and the
 * loader only requires `~standard.validate`.
 */
export const Config = {
  '~standard': {
    vendor: 'dsh-web-search-opencode',
    version: 1,
    /**
     * Validate a raw config object, filling documented defaults and reporting
     * every problem at once.
     *
     * @param {unknown} value - the raw config from the loader row.
     * @returns {{ value: import('./lib/types.js').ProviderOptions } | { issues: Array<{ message: string, path: string[] }> }} the validated config or the issues.
     */
    validate(value) {
      /** @type {Array<{ message: string, path: string[] }>} */ const issues = []
      const raw = value === null || typeof value !== 'object' ? {} : /** @type {Record<string, unknown>} */ (value)

      /** @param {string} key */
      const pickString = (key) => {
        const candidate = raw[key]
        if (candidate === undefined || candidate === '') return undefined
        if (typeof candidate !== 'string') {
          issues.push({ message: `${key} must be a string`, path: [key] })
          return undefined
        }
        return candidate
      }

      /**
       * @param {string} key
       * @param {number} fallback
       * @param {number} [min]
       */
      const pickNumber = (key, fallback, min = 1) => {
        const candidate = raw[key]
        if (candidate === undefined) return fallback
        if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
          issues.push({ message: `${key} must be a number`, path: [key] })
          return fallback
        }
        if (candidate < min) {
          issues.push({ message: `${key} must be at least ${min}`, path: [key] })
          return fallback
        }
        return candidate
      }

      /**
       * @template {string} T
       * @param {string} key
       * @param {T} fallback
       * @param {readonly T[]} allowed
       * @returns {T}
       */
      const pickUnion = (key, fallback, allowed) => {
        const candidate = raw[key]
        if (candidate === undefined || candidate === '') return fallback
        if (typeof candidate !== 'string' || !allowed.includes(/** @type {T} */ (candidate))) {
          issues.push({ message: `${key} must be one of: ${allowed.join(', ')}`, path: [key] })
          return fallback
        }
        return /** @type {T} */ (candidate)
      }

      if (issues.length > 0) return { issues }

      const env = process.env
      const envMode = /** @type {'auto' | 'exa' | 'parallel'} */ (readEnv(env, 'OPENCODE_WEBSEARCH_PROVIDER') ?? 'auto')
      const mode = /** @type {'auto' | 'exa' | 'parallel'} */ (pickUnion('provider', envMode, PROVIDER_MODES))
      const exaApiKey = pickString('exaApiKey') ?? env.EXA_API_KEY ?? ''
      const parallelApiKey = pickString('parallelApiKey') ?? env.PARALLEL_API_KEY ?? ''
      const numResults = pickNumber('numResults', DEFAULT_NUM_RESULTS)
      const searchType = /** @type {'auto' | 'fast' | 'deep'} */ (pickUnion('searchType', DEFAULT_SEARCH_TYPE, SEARCH_TYPES))
      const livecrawl = /** @type {'fallback' | 'preferred'} */ (pickUnion('livecrawl', DEFAULT_LIVECRAWL, LIVECRAWLS))
      const contextMaxCharacters = pickNumber('contextMaxCharacters', DEFAULT_CONTEXT_MAX_CHARS)
      const timeoutMs = pickNumber('timeoutMs', MCP_TIMEOUT_MS, 1000)
      const modelName = pickString('modelName')

      if (issues.length > 0) return { issues }
      return {
        value: {
          provider: mode,
          exaApiKey,
          parallelApiKey,
          numResults: Math.floor(numResults),
          searchType,
          livecrawl,
          contextMaxCharacters: Math.floor(contextMaxCharacters),
          ...(modelName !== undefined ? { modelName } : {}),
          timeoutMs: Math.floor(timeoutMs),
        },
      }
    },
  },
  /** JSON-Schema projection for config editors; not consumed by validation. */
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      provider: {
        type: 'string',
        enum: PROVIDER_MODES,
        default: 'auto',
        description: 'Backend selection: auto (per-query split) | exa | parallel. Falls back to $OPENCODE_WEBSEARCH_PROVIDER.',
      },
      exaApiKey: {
        type: 'string',
        description: 'Exa API key, appended as ?exaApiKey=. Falls back to $EXA_API_KEY. Empty means keyless access.',
      },
      parallelApiKey: {
        type: 'string',
        description: 'Parallel API key, sent as an Authorization bearer. Falls back to $PARALLEL_API_KEY.',
      },
      numResults: {
        type: 'integer',
        minimum: 1,
        default: DEFAULT_NUM_RESULTS,
        description: 'Results requested from the backend. The seam still enforces the tool request bound.',
      },
      searchType: {
        type: 'string',
        enum: SEARCH_TYPES,
        default: DEFAULT_SEARCH_TYPE,
        description: 'Exa retrieval mode.',
      },
      livecrawl: {
        type: 'string',
        enum: LIVECRAWLS,
        default: DEFAULT_LIVECRAWL,
        description: 'Exa live-crawl policy.',
      },
      contextMaxCharacters: {
        type: 'integer',
        minimum: 1,
        default: DEFAULT_CONTEXT_MAX_CHARS,
        description: 'Exa per-result context budget in characters.',
      },
      modelName: {
        type: 'string',
        description: 'Model name forwarded to Parallel as model_name.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1000,
        default: MCP_TIMEOUT_MS,
        description: 'Per-request budget in milliseconds.',
      },
    },
  },
}

/** Field descriptors kept next to the schema so the JSON projection stays derived. */
export const CONFIG_FIELDS = {
  provider: field({ kind: 'union', options: PROVIDER_MODES, description: 'Backend selection.', default: 'auto' }),
  exaApiKey: field({ kind: 'string', description: 'Exa API key.', default: '' }),
  parallelApiKey: field({ kind: 'string', description: 'Parallel API key.', default: '' }),
  numResults: field({ kind: 'number', min: 1, integer: 1, description: 'Results requested from the backend.', default: DEFAULT_NUM_RESULTS }),
  searchType: field({ kind: 'union', options: SEARCH_TYPES, description: 'Exa retrieval mode.', default: DEFAULT_SEARCH_TYPE }),
  livecrawl: field({ kind: 'union', options: LIVECRAWLS, description: 'Exa live-crawl policy.', default: DEFAULT_LIVECRAWL }),
  contextMaxCharacters: field({ kind: 'number', min: 1, integer: 1, description: 'Exa per-result context budget.', default: DEFAULT_CONTEXT_MAX_CHARS }),
  modelName: field({ kind: 'string', description: 'Model name forwarded to Parallel.' }),
  timeoutMs: field({ kind: 'number', min: 1000, integer: 1, description: 'Per-request budget in milliseconds.', default: MCP_TIMEOUT_MS }),
}

/**
 * Read one environment variable, treating a blank value as unset.
 *
 * @param {NodeJS.ProcessEnv} env - the process environment.
 * @param {string} key - the variable name.
 * @returns {string | undefined} the value, or `undefined`.
 */
function readEnv(env, key) {
  const value = env[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Register the OpenCode-style search provider with `ctx.web`.
 *
 * The registration is owned by this plugin's fiber: unloading the plugin (or
 * disabling its row) unregisters the provider from the seam.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {import('./lib/types.js').ProviderOptions} config - the validated config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = {
    provider: config.provider,
    exaApiKey: config.exaApiKey,
    parallelApiKey: config.parallelApiKey,
    numResults: config.numResults,
    searchType: config.searchType,
    livecrawl: config.livecrawl,
    contextMaxCharacters: config.contextMaxCharacters,
    ...(config.modelName !== undefined ? { modelName: config.modelName } : {}),
    timeoutMs: config.timeoutMs,
  }
  ctx.effect(() => {
    const provider = new OpenCodeSearchProvider(options, { errorClass: SearchProviderError })
    const dispose = ctx.web.registerSearchProvider(provider)
    ctx.logger?.info?.('web search provider registered: %s (%s)', provider.id, options.provider)
    return () => {
      dispose()
    }
  }, 'web-search-opencode.registerSearchProvider')
}

export { isAbortError }

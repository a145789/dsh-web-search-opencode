/**
 * Ambient declarations for the two harness types this plugin mentions only in
 * JSDoc, plus the seam vocabulary it is structurally compatible with.
 *
 * The plugin deliberately imports nothing at runtime — a profile-installed
 * bundle cannot reliably resolve harness internals — so `tsc --checkJs` needs
 * these shims to check the JSDoc against the real contracts' shape.
 *
 * @module dsh-web-search-opencode/jsconfig-shims
 */

declare module '@deepseek-ai/cordis' {
  /** The subset of the cordis `Context` this plugin uses. */
  export interface Context {
    /** Register a disposable effect owned by this plugin's fiber. */
    effect(callback: () => (() => void) | void, name?: string): void
    /** The web capability seam, provided by `@deepseek-ai/dsh-web`. */
    web: {
      registerSearchProvider(provider: {
        id: string
        available(): boolean
        search(request: { query: string, maxResults?: number }, signal?: AbortSignal): Promise<{
          content?: string
          sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>
          truncated: boolean
        }>
      }): () => void
    }
    logger?: { info?(message: string, ...args: unknown[]): void }
  }
}

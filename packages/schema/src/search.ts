import type { ScopeType } from './scope'

/**
 * A single ranked retrieval result (plan §14.4).
 *
 * `reasons` carries the per-signal contributions that ranked this item in
 * (e.g. "entity", "bm25", "scope:user") so ranking is inspectable.
 */
export interface SearchResultItem {
  factId: string
  statement: string
  /** Scope key (`type:key`) the fact belongs to. */
  scope: string
  score: number
  reasons: string[]
  temporal: { validFrom: string | null; validTo: string | null }
  evidenceRefs: string[]
}

/**
 * Retrieval query input (plan §14).
 *
 * Scope filtering is resolved before ranking (plan §9.4): `scopes` is the
 * explicit allowed read set; omit to use the default read order. `global`
 * opts into the query-time global expansion. `asOf`/`includeHistory` control
 * current-view vs history (plan §14.3).
 */
export interface SearchQuery {
  text: string
  /** Explicit allowed scope set; omit to use the default read order. */
  scopes?: ScopeType[]
  /** Opt into the query-time global read expansion (plan §9.3). */
  global?: boolean
  limit?: number
  /** Include superseded facts / point-in-time view (plan §14.3). */
  includeHistory?: boolean
  asOf?: string
}

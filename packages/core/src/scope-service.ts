import { SCOPE_RANK, type Scope, type ScopeType } from '@naru/schema'
import type { Store } from '@naru/store-sqlite'

/**
 * Input describing the allowed read scope set for a retrieval (plan §9).
 *
 * - `scope`/`scopes`: explicit `(type, key)` selectors; the resolved set is the
 *   union of these.
 * - `global`: opt into the query-time global expansion (plan §9.3) — expands to
 *   every `project` and `user` scope known to the store.
 * - When nothing is provided, resolves to the EMPTY set (fail-safe): broad reads
 *   require explicit scope or `global` intent (plan §9.3/§9.4).
 */
export interface ScopeSelector {
  type: ScopeType
  key: string
}

/**
 * Scope type valid as a WRITE target. Excludes `global`, which is a query-time
 * read alias only — never a stored scope row or write target (plan §9.1, §9.2).
 */
export type WritableScopeType = Exclude<ScopeType, 'global'>

/** A `(type, key)` selector for a WRITE; `type` cannot be `global` (plan §9.2). */
export interface WritableScopeSelector {
  type: WritableScopeType
  key: string
}

/** Allowed-scope resolution input (plan §9.4). */
export interface ResolveScopesInput {
  scope?: ScopeSelector
  scopes?: ScopeSelector[]
  global?: boolean
  /** Convenience selectors for explicit user/project reads. */
  user?: string
  project?: string
  /**
   * Bound a `global` expansion to a single user (plan §9.1/§9.3: "every project
   * scope belonging to the CURRENT user"). When set together with `global`, the
   * expansion is filtered to this user's `user` scope plus the `project` scopes
   * — without it, `global` expands to EVERY project + user scope in the store,
   * which leaks cross-user scopes on a shared DB. Currently the store has no
   * project→user ownership edge, so project scopes are not yet attributable to a
   * user; until that exists, `globalUser` constrains the `user`-typed half of
   * the expansion to just the requesting user and the project half stays
   * unfiltered. See the adapter (plan §17) which threads the resolved user here.
   */
  globalUser?: string
}

/** Resolved allowed scope set: the scope rows plus their unique keys. */
export interface ResolvedScopes {
  scopeKeys: string[]
  scopes: Scope[]
}

/**
 * Scope resolution + lifecycle service (plan §9).
 *
 * Owns get-or-create of scope rows and the allowed-scope resolution that MUST
 * run before candidate retrieval and ranking (plan §9.4). `global` is handled
 * here as a query-time alias (plan §9.3): it is never stored as a row.
 */
export class ScopeService {
  constructor(private readonly store: Store) {}

  /** Get-or-create a scope by `(type, key)` (plan §11.2). */
  ensureScope(type: ScopeType, key: string, name?: string): Scope {
    return this.store.scopes.ensure({ type, keyPart: key, name })
  }

  /** List all known scope rows (plan §15.2 `scope.list`). */
  list(): Scope[] {
    return this.store.scopes.list()
  }

  /** Ranking weight for a scope type (plan §9.3). Higher = closer/preferred. */
  rankWeight(type: ScopeType): number {
    return SCOPE_RANK[type]
  }

  /**
   * Resolve the allowed scope set (plan §9.4).
   *
   * Resolution order:
   * 1. `global` -> every `project` + `user` scope known to the store (query-time
   *    alias expansion, plan §9.3); never reads a `global` row. When
   *    `globalUser` is set, the `user`-typed half is filtered to that user
   *    (plan §9.1: "belonging to the CURRENT user") so a shared DB does not leak
   *    other users' `user` scopes. (Project scopes carry no user-ownership edge
   *    in the store yet, so the project half cannot be user-filtered here; a
   *    caller on a shared DB must treat the project half as cross-user — see the
   *    adapter's documented limitation, plan §17.)
   * 2. explicit `scope`/`scopes`/`user`/`project` selectors -> their union.
   * 3. nothing requested -> the EMPTY set (fail-safe, plan §9.3/§9.4): broad
   *    reads must require explicit scope or `global` intent rather than silently
   *    fanning out to every project + user scope.
   *
   * Only scopes that actually exist as rows are returned; unknown selectors are
   * dropped (a search against a non-existent scope yields no candidates rather
   * than leaking).
   */
  resolveAllowedScopes(input: ResolveScopesInput = {}): ResolvedScopes {
    if (input.global) {
      const all = this.store.scopes.list()
      const globalUserKey = input.globalUser !== undefined ? `user:${input.globalUser}` : undefined
      const scopes = all.filter((s) => {
        if (s.type === 'project') {
          return true
        }
        if (s.type === 'user') {
          // Bound the user half to the requesting user when known; otherwise
          // (legacy unbounded global) keep every user scope.
          return globalUserKey === undefined || s.key === globalUserKey
        }
        return false
      })
      return this.dedupe(scopes)
    }

    const selectors: ScopeSelector[] = []
    if (input.scope) {
      selectors.push(input.scope)
    }
    if (input.scopes) {
      selectors.push(...input.scopes)
    }
    if (input.user) {
      selectors.push({ type: 'user', key: input.user })
    }
    if (input.project) {
      selectors.push({ type: 'project', key: input.project })
    }

    if (selectors.length === 0) {
      return { scopeKeys: [], scopes: [] }
    }

    const resolved: Scope[] = []
    for (const sel of selectors) {
      const scope = this.store.scopes.getByKey(`${sel.type}:${sel.key}`)
      if (scope) {
        resolved.push(scope)
      }
    }
    return this.dedupe(resolved)
  }

  private dedupe(scopes: Scope[]): ResolvedScopes {
    const byKey = new Map<string, Scope>()
    for (const s of scopes) {
      byKey.set(s.key, s)
    }
    const unique = [...byKey.values()]
    return { scopeKeys: unique.map((s) => s.key), scopes: unique }
  }
}

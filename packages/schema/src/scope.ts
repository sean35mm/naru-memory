import { z } from 'zod'

/**
 * Concrete scope types that exist as rows in the `scopes` table.
 *
 * NOTE: `global` is intentionally NOT in this tuple. Per plan §9.1, `global`
 * is a query-time alias that expands the read set to every project scope of
 * the current user — it is never a stored scope row and never a write target.
 * It appears only in {@link SCOPE_RANK} so ranking can reason about an explicit
 * global read.
 */
export const SCOPE_TYPES = [
  'user',
  'workspace',
  'project',
  'branch',
  'session',
  'agent',
  'global',
] as const

export type ScopeType = (typeof SCOPE_TYPES)[number]

export const ScopeTypeSchema = z.enum(SCOPE_TYPES)

/**
 * Build the unique scope key (`scopes.key`) from a type and a key part.
 * Format: `${type}:${key}` (plan §11.2 — unique on type + key).
 */
export function scopeKey(type: ScopeType, key: string): string {
  return `${type}:${key}`
}

export interface Scope {
  id: string
  type: ScopeType
  name: string
  /** Unique key, conventionally `scopeKey(type, key)`. */
  key: string
  parentScopeId: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export const ScopeSchema: z.ZodType<Scope> = z.object({
  id: z.string(),
  type: ScopeTypeSchema,
  name: z.string(),
  key: z.string(),
  parentScopeId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * Ranking weights preferring closer scopes (plan §9.3):
 *
 *   session > agent > branch > project > workspace > user > global
 *
 * Higher number = higher priority. `global` members are ranked by their
 * underlying project/user scope; this weight is the floor used only when a
 * query explicitly opts into a global read.
 */
export const SCOPE_RANK: Record<ScopeType, number> = {
  session: 6,
  agent: 5,
  branch: 4,
  project: 3,
  workspace: 2,
  user: 1,
  global: 0,
}

/**
 * Default read order for `context.build` (plan §9.3):
 *
 *   session -> agent -> branch -> project -> workspace -> user
 *
 * `global` is excluded: it is opt-in only and resolved as a query-time
 * scope-set expansion, not part of the normal developer read order.
 */
export const DEFAULT_READ_ORDER: readonly ScopeType[] = [
  'session',
  'agent',
  'branch',
  'project',
  'workspace',
  'user',
]

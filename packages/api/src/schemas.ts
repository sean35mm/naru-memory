import { FactStatusSchema, ScopeTypeSchema, SourceTypeSchema } from '@naru/schema'
import { z } from 'zod'

/**
 * Shared zod input fragments for the routers. Kept here so input validation is
 * consistent across procedures and maps cleanly onto the core facade types
 * (`ScopeSelector`, `AddManualInput`, `SearchInput`, etc.).
 */

/**
 * A `(type, key)` scope selector matching core `ScopeSelector`.
 *
 * Used for READ procedures (search/list/context/entity), where `global` is a
 * meaningful query-time alias (plan §9.1, §9.3) that expands the read set. It
 * must NOT be used for write scopes — see {@link WritableScopeSelectorSchema}.
 */
export const ScopeSelectorSchema = z.object({
  type: ScopeTypeSchema,
  key: z.string().min(1),
})

/**
 * A write-only scope selector that excludes `global` (plan §9.1, §9.2).
 *
 * `global` is a query-time read alias, never a stored scope row and never a
 * write target — a "global" write resolves to `user`, it does not create a
 * `global` row. The write entry points (`memory.add`, `episode.capture`) MUST
 * use this so a `global` write is rejected at the transport boundary, mirroring
 * `scope.resolve`'s `ResolvableScopeTypeSchema`.
 */
export const WritableScopeSelectorSchema = z.object({
  type: ScopeTypeSchema.exclude(['global']),
  key: z.string().min(1),
})

/** Re-export of the canonical source-type enum for write inputs. */
export const SourceTypeInput = SourceTypeSchema

/** Re-export of the canonical fact-status enum for list filters. */
export const FactStatusInput = FactStatusSchema

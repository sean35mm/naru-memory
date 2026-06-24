import { ulid } from 'ulid'

/**
 * Generate a prefixed, sortable, collision-resistant identifier.
 *
 * Uses ULID for the suffix: lexicographically sortable by creation time,
 * generable offline without coordination, and stable across export/import
 * so references survive round-trips (plan §11.5).
 *
 * Example: `newId("fact")` -> "fact_01HZX...".
 */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`
}

/** Convenience helpers for the canonical entity prefixes. */
export const newScopeId = (): string => newId('scope')
export const newEpisodeId = (): string => newId('ep')
export const newEntityId = (): string => newId('ent')
export const newFactId = (): string => newId('fact')
export const newEvidenceId = (): string => newId('ev')
export const newEdgeId = (): string => newId('edge')
export const newSupersessionId = (): string => newId('sup')
export const newEmbeddingId = (): string => newId('emb')

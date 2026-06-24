import { z } from 'zod'

/**
 * Episode text retention modes (plan §10.1).
 *
 * - `redacted` (default): store redacted episode text, evidence snippets, and
 *   source hashes — rebuildable + auditable.
 * - `minimal`: store facts and evidence hashes only, no episode body.
 * - `encrypted`: store original source encrypted locally (later milestone).
 * - `none`: store extracted facts only, no episode/evidence text.
 *
 * `minimal`/`none` trade rebuildability/auditability for privacy (plan §10.1).
 */
export const RETENTION_MODES = ['redacted', 'minimal', 'encrypted', 'none'] as const

export type RetentionMode = (typeof RETENTION_MODES)[number]

export const RetentionModeSchema = z.enum(RETENTION_MODES)

/** Default retention balances privacy and auditability (plan §10.2). */
export const DEFAULT_RETENTION: RetentionMode = 'redacted'

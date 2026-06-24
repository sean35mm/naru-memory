/**
 * Uniform result envelope returned across the CLI/API boundary.
 *
 * Either `ok: true` with `data`, or `ok: false` with `error`. The optional
 * fields carry common cross-cutting metadata (timing, scope, count) without
 * forcing every payload to model them.
 */
export interface JsonEnvelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
  durationMs?: number
  scope?: string
  count?: number
}

/** Build a success envelope, optionally merging extra metadata fields. */
export function ok<T>(
  data: T,
  extra?: Omit<JsonEnvelope<T>, 'ok' | 'data' | 'error'>,
): JsonEnvelope<T> {
  return { ok: true, data, ...extra }
}

/** Build an error envelope from a code + message. */
export function err(code: string, message: string): JsonEnvelope<never> {
  return { ok: false, error: { code, message } }
}

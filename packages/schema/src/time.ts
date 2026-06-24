/**
 * Current wall-clock time as an ISO-8601 UTC string.
 *
 * All timestamps in Naru are stored as ISO-8601 text for portability and
 * deterministic ordering.
 */
export function nowIso(): string {
  return new Date().toISOString()
}

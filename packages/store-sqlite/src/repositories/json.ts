/**
 * Shared row<->domain JSON helpers for repositories.
 *
 * Canonical rows store object/array fields as JSON text in `*_json` columns
 * (e.g. `metadata_json`, `aliases_json`). These helpers centralize the
 * parse/stringify so repositories map snake_case rows to camelCase domain
 * objects consistently.
 */

/** Parse a `metadata_json` column into a record, tolerating null/empty. */
export function parseRecord(json: string | null | undefined): Record<string, unknown> {
  if (!json) {
    return {}
  }
  return JSON.parse(json) as Record<string, unknown>
}

/** Serialize a metadata record to its `*_json` column form. */
export function stringifyRecord(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {})
}

/** Parse an `aliases_json` column into a string array, tolerating null/empty. */
export function parseStringArray(json: string | null | undefined): string[] {
  if (!json) {
    return []
  }
  return JSON.parse(json) as string[]
}

/** Serialize a string array to its `*_json` column form. */
export function stringifyStringArray(value: string[] | undefined): string {
  return JSON.stringify(value ?? [])
}

import { type JsonEnvelope, err, ok } from '@naru/schema'

/**
 * Output mode + timing context for a single CLI command (plan §16).
 *
 * `json` selects machine output (a single-line {@link JsonEnvelope} on stdout,
 * no colors/spinners). `startedAt` is captured when the program starts so every
 * envelope can report `durationMs`.
 */
export interface OutputContext {
  json: boolean
  startedAt: number
}

/** Extra metadata merged into a success envelope (plan §16 `scope`/`count`). */
export interface SuccessMeta {
  scope?: string
  count?: number
  /** Human-readable lines to print in non-JSON mode (one per array entry). */
  human?: string[]
}

/** Elapsed wall-clock time since the command started, in whole milliseconds. */
function elapsed(ctx: OutputContext): number {
  return Math.max(0, Math.round(Date.now() - ctx.startedAt))
}

/** Serialize an envelope as a single line of JSON for stdout (plan §16). */
function printJsonLine<T>(envelope: JsonEnvelope<T>): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`)
}

/**
 * Emit a success result (plan §16).
 *
 * In `--json` mode prints exactly one JSON envelope line (with `durationMs` and
 * any `scope`/`count` metadata). In human mode prints the supplied readable
 * lines, or a minimal `ok` fallback when none are given.
 */
export function emitSuccess<T>(ctx: OutputContext, data: T, meta: SuccessMeta = {}): void {
  if (ctx.json) {
    printJsonLine(
      ok(data, {
        durationMs: elapsed(ctx),
        ...(meta.scope !== undefined ? { scope: meta.scope } : {}),
        ...(meta.count !== undefined ? { count: meta.count } : {}),
      }),
    )
    return
  }
  const lines = meta.human ?? ['ok']
  for (const line of lines) {
    process.stdout.write(`${line}\n`)
  }
}

/**
 * Emit an error result and set exit code 1 (plan §16).
 *
 * In `--json` mode prints one error envelope line to stdout; in human mode
 * prints a readable message to stderr. Never throws.
 */
export function emitError(ctx: OutputContext, code: string, message: string): void {
  process.exitCode = 1
  if (ctx.json) {
    printJsonLine({ ...err(code, message), durationMs: elapsed(ctx) })
    return
  }
  process.stderr.write(`error: ${message}\n`)
}

/** Map an unknown thrown value to a stable `{ code, message }` pair. */
export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: 'error', message: error.message }
  }
  return { code: 'error', message: String(error) }
}

/**
 * Runnable `naru-server` entry (plan §15.3). Kept SEPARATE from the library
 * barrel (`./index.ts`) so the run-if-invoked guard below is never bundled into
 * the CLI — otherwise it would misfire (its `import.meta.url` and the CLI's
 * `process.argv[1]` both resolve to the CLI bundle) and auto-start the server on
 * every `naru` command. The CLI starts the server by calling `createServer`
 * directly; this file is only for running the standalone server process.
 */
import { argv, env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { type CreateServerOptions, createServer } from './server'

/**
 * Parse `--host` / `--port` flags (with `=` or space form) from process args.
 * The DB path comes from `NARU_DB` (env), falling back to core's default.
 */
function parseArgs(args: string[]): CreateServerOptions {
  const opts: CreateServerOptions = {}
  if (typeof env.NARU_DB === 'string' && env.NARU_DB !== '') {
    opts.db = env.NARU_DB
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) {
      continue
    }
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) {
        return inlineValue
      }
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        i++
        return next
      }
      return undefined
    }
    if (key === '--host') {
      const v = takeValue()
      if (v !== undefined) {
        opts.host = v
      }
    } else if (key === '--port') {
      const v = takeValue()
      const n = v === undefined ? Number.NaN : Number.parseInt(v, 10)
      if (Number.isInteger(n)) {
        opts.port = n
      }
    }
  }
  return opts
}

/** Entry point: start the server and stay up until a termination signal. */
async function main(): Promise<void> {
  const handle = await createServer(parseArgs(argv.slice(2)))
  // Log the bound URL only — never the token (it lives in the 0600 file).
  process.stderr.write(`[naru-server] listening on ${handle.url}\n`)

  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    process.stderr.write(`[naru-server] ${signal} received, shutting down\n`)
    handle
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(`[naru-server] shutdown error: ${String(err)}\n`)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Run only when invoked directly (as the `naru-server` bin), not on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`[naru-server] failed to start: ${String(err)}\n`)
    process.exit(1)
  })
}

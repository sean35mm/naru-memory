import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const entry = 'apps/cli/src/index.ts'

let tmpDir: string
let dbPath: string

/** Run the CLI via `pnpm exec tsx ...` and return parsed stdout JSON. */
function runJson(args: string[]): Record<string, unknown> {
  const stdout = execFileSync('pnpm', ['exec', 'tsx', entry, '--db', dbPath, ...args, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const lines = stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  return JSON.parse(last) as Record<string, unknown>
}

/**
 * Run the CLI expecting a non-zero exit, returning the parsed stdout envelope
 * and exit status (execFileSync throws on non-zero, exposing stdout/status).
 */
function runJsonExpectFail(args: string[]): { status: number; env: Record<string, unknown> } {
  try {
    execFileSync('pnpm', ['exec', 'tsx', entry, '--db', dbPath, ...args, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    throw new Error('expected the CLI to exit non-zero')
  } catch (error) {
    const e = error as { status?: number; stdout?: string }
    const stdout = (e.stdout ?? '').trim()
    const last = stdout.split('\n').pop() ?? ''
    return { status: e.status ?? 0, env: JSON.parse(last) as Record<string, unknown> }
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'naru-cli-smoke-'))
  dbPath = join(tmpDir, 'naru.db')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('naru CLI smoke', () => {
  it('init returns ok', () => {
    const env = runJson(['init'])
    expect(env.ok).toBe(true)
  })

  it('add returns ok', () => {
    const env = runJson(['add', 'User prefers dark mode', '--scope', 'user:test'])
    expect(env.ok).toBe(true)
  })

  it('search finds the added fact', () => {
    const env = runJson(['search', 'dark', '--scope', 'user:test'])
    expect(env.ok).toBe(true)
    const data = env.data as { results: { statement: string }[] }
    expect(data.results.length).toBeGreaterThan(0)
    expect(data.results.some((r) => /dark mode/i.test(r.statement))).toBe(true)
  })

  it('status returns ok', () => {
    const env = runJson(['status'])
    expect(env.ok).toBe(true)
  })

  it('a subcommand parse error yields an error envelope with exit 1 (plan §16)', () => {
    // `add` with no <text...> is a missing-required-argument parse error: it must
    // surface as ok:false on stdout and exit 1, not a silent empty body.
    const { status, env } = runJsonExpectFail(['add'])
    expect(status).toBe(1)
    expect(env.ok).toBe(false)
    expect((env.error as { message?: string } | undefined)?.message).toMatch(/missing required/i)
  })
})

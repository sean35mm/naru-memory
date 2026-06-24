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

/** Run the CLI via `pnpm exec tsx ...` and return the parsed stdout envelope. */
function runJson(args: string[]): Record<string, unknown> {
  const stdout = execFileSync('pnpm', ['exec', 'tsx', entry, '--db', dbPath, ...args, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const lines = stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  return JSON.parse(last) as Record<string, unknown>
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'naru-cli-capture-'))
  dbPath = join(tmpDir, 'naru.db')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('naru capture (plan §13 extraction-driven ingestion)', () => {
  // Each runJson spawns a cold `tsx` subprocess (~1-2s); this case makes three,
  // so it needs a generous timeout beyond vitest's 5s default.
  it('capture --llm-provider mock extracts multiple facts that are searchable', () => {
    // Deterministic offline mock extractor: a two-sentence input -> >1 fact, no network.
    const env = runJson([
      'capture',
      'User prefers dark mode. The API rate limit is 100 requests per minute.',
      '--scope',
      'user:capt',
      '--llm-provider',
      'mock',
    ])
    expect(env.ok).toBe(true)
    const data = env.data as {
      episode: { id: string }
      facts: { id: string; status: string; statement: string }[]
    }
    expect(data.episode.id).toMatch(/^ep_/)
    expect(data.facts.length).toBeGreaterThan(1)
    expect(data.facts.every((f) => f.id.startsWith('fact_') && f.status === 'active')).toBe(true)

    // The extracted facts are retrievable via search in the same scope.
    const darkEnv = runJson(['search', 'dark mode', '--scope', 'user:capt'])
    expect(darkEnv.ok).toBe(true)
    const darkResults = (darkEnv.data as { results: { statement: string }[] }).results
    expect(darkResults.some((r) => /dark mode/i.test(r.statement))).toBe(true)

    const rateEnv = runJson(['search', 'rate limit', '--scope', 'user:capt'])
    const rateResults = (rateEnv.data as { results: { statement: string }[] }).results
    expect(rateResults.some((r) => /rate limit/i.test(r.statement))).toBe(true)
  }, 30_000)

  it('status --json reports the extractor as available when a provider is configured', () => {
    const env = runJson(['status', '--llm-provider', 'mock'])
    expect(env.ok).toBe(true)
    const status = env.data as {
      features: { extractor: { available: boolean; provider?: string } }
    }
    expect(status.features.extractor.available).toBe(true)
    expect(status.features.extractor.provider).toBe('mock')
  }, 15_000)

  it('status --json reports the extractor as unavailable with no provider', () => {
    const env = runJson(['status'])
    expect(env.ok).toBe(true)
    const status = env.data as { features: { extractor: { available: boolean } } }
    expect(status.features.extractor).toEqual({ available: false })
  }, 15_000)
})

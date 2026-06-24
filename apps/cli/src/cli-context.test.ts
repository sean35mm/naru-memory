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
  tmpDir = mkdtempSync(join(tmpdir(), 'naru-cli-context-'))
  dbPath = join(tmpDir, 'naru.db')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * `naru context` (plan §14.4 `context.build`).
 *
 * The command runs the hybrid scope-safe search then packs the top-ranked facts
 * into a token-bounded prompt block. These spawn cold `tsx` subprocesses, so each
 * `it` carries a generous timeout beyond vitest's 5s default. The `--embed-*`
 * flags wire the deterministic offline MockEmbedder (no network).
 */
describe('naru context (plan §14.4)', () => {
  it('returns a budget-bounded prompt block + token estimate with the mock embedder', () => {
    // Seed several facts that all match the query lexically, then deliberately
    // build vectors so the hybrid + semantic path is exercised (plan §12.2).
    for (let i = 0; i < 12; i++) {
      const env = runJson([
        'add',
        `Deployment runbook step ${i}: run the migration then restart the service worker pool`,
        '--scope',
        'project:ctx',
        '--embed-provider',
        'mock',
      ])
      expect(env.ok).toBe(true)
    }
    const reindexed = runJson(['reindex', '--embed-provider', 'mock'])
    expect(reindexed.ok).toBe(true)

    const budget = 60
    const env = runJson([
      'context',
      'deployment runbook migration restart service worker',
      '--scope',
      'project:ctx',
      '--embed-provider',
      'mock',
      '--token-budget',
      String(budget),
    ])
    expect(env.ok).toBe(true)
    const data = env.data as {
      items: { factId: string; scope: string; reason: string[] }[]
      promptBlock: string
      tokenEstimate: number
    }
    // A populated, budget-bounded prompt block (hard guarantee, plan §14.4).
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.promptBlock.length).toBeGreaterThan(0)
    expect(data.tokenEstimate).toBeLessThanOrEqual(budget)
    // The estimate is exactly ceil(chars/4) of the assembled block.
    expect(data.tokenEstimate).toBe(Math.ceil(data.promptBlock.length / 4))
    // Packing had to drop items (more matched than fit) -> proves the budget bound.
    expect(data.items.length).toBeLessThan(12)
    // Every packed item is in-scope and carries its per-signal reasons.
    for (const item of data.items) {
      expect(item.scope).toBe('project:ctx')
      expect(item.reason.length).toBeGreaterThan(0)
    }
  }, 60_000)

  it('status --json reports the vector backend available when an embedder is configured', () => {
    const env = runJson(['status', '--embed-provider', 'mock'])
    expect(env.ok).toBe(true)
    const status = env.data as {
      features: {
        vector: { backend: string; embedder: { available: boolean; provider?: string } }
      }
    }
    expect(status.features.vector.backend).toBe('bruteforce')
    expect(status.features.vector.embedder.available).toBe(true)
    expect(status.features.vector.embedder.provider).toBe('mock')
  }, 15_000)

  it('status --json reports the vector embedder unavailable with no provider', () => {
    const env = runJson(['status'])
    expect(env.ok).toBe(true)
    const status = env.data as {
      features: { vector: { backend: string; embedder: { available: boolean } } }
    }
    expect(status.features.vector.backend).toBe('bruteforce')
    expect(status.features.vector.embedder).toEqual({ available: false })
  }, 15_000)
})

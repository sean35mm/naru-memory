import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const entry = 'apps/cli/src/index.ts'

let tmpDir: string
let dbA: string
let dbB: string
let bundleFile: string
let backupFile: string

/** Run the CLI against a given DB and return the parsed last stdout JSON line. */
function runJson(db: string, args: string[]): Record<string, unknown> {
  const stdout = execFileSync('pnpm', ['exec', 'tsx', entry, '--db', db, ...args, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const lines = stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  return JSON.parse(last) as Record<string, unknown>
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'naru-cli-portability-'))
  dbA = join(tmpDir, 'a.db')
  dbB = join(tmpDir, 'b.db')
  bundleFile = join(tmpDir, 'bundle.json')
  backupFile = join(tmpDir, 'snapshot.db')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// Each `it` spawns the CLI through a cold `pnpm exec tsx` (sometimes several
// times), so it carries a generous timeout beyond vitest's 5s default — the
// same convention the other spawn-based CLI tests use, since cold tsx startup
// contends with the rest of the suite under full-run concurrency.
describe('naru M5 portability (export/import/doctor/backup, plan §16/§19/§20/§22)', () => {
  it('seeds the source DB with a couple of facts', () => {
    expect(runJson(dbA, ['init']).ok).toBe(true)
    expect(runJson(dbA, ['add', 'User prefers dark mode', '--scope', 'user:alice']).ok).toBe(true)
    expect(
      runJson(dbA, ['add', 'Project uses TypeScript strict mode', '--scope', 'project:naru']).ok,
    ).toBe(true)
  }, 30_000)

  it('export writes a bundle file and reports the counts written', () => {
    const env = runJson(dbA, ['export', bundleFile])
    expect(env.ok).toBe(true)
    expect(existsSync(bundleFile)).toBe(true)
    const data = env.data as {
      file: string
      schemaVersion: string
      counts: { facts: number; scopes: number }
    }
    expect(data.file).toBe(bundleFile)
    expect(typeof data.schemaVersion).toBe('string')
    expect(data.counts.facts).toBe(2)
    // Default scopes (user/project from init) plus any add-time scopes.
    expect(data.counts.scopes).toBeGreaterThanOrEqual(2)
  }, 15_000)

  it('export rejects --scope (a bundle is a whole-store snapshot, plan §19)', () => {
    try {
      execFileSync(
        'pnpm',
        [
          'exec',
          'tsx',
          entry,
          '--db',
          dbA,
          'export',
          bundleFile,
          '--scope',
          'user:alice',
          '--json',
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      )
      throw new Error('expected non-zero exit')
    } catch (error) {
      const e = error as { status?: number; stdout?: string }
      const last = (e.stdout ?? '').trim().split('\n').pop() ?? ''
      const env = JSON.parse(last) as Record<string, unknown>
      expect(e.status).toBe(1)
      expect(env.ok).toBe(false)
      expect((env.error as { message?: string }).message).toMatch(/--scope/i)
    }
  }, 15_000)

  it('import loads the bundle into a fresh second DB', () => {
    expect(runJson(dbB, ['init']).ok).toBe(true)
    const env = runJson(dbB, ['import', bundleFile])
    expect(env.ok).toBe(true)
    const data = env.data as {
      imported: { facts: number }
      skippedDuplicates: number
      remappedIds: number
      reembedNeeded?: { reason: string }
    }
    expect(data.imported.facts).toBe(2)
    // No embedder configured by default, so the importer reports re-embed needed.
    expect(data.reembedNeeded).toBeDefined()
  }, 20_000)

  it('search on the second DB finds the imported facts (FTS rebuilt on import)', () => {
    const env = runJson(dbB, ['search', 'dark', '--scope', 'user:alice'])
    expect(env.ok).toBe(true)
    const data = env.data as { results: { statement: string }[] }
    expect(data.results.some((r) => /dark mode/i.test(r.statement))).toBe(true)
  }, 15_000)

  it('re-importing the same bundle reports duplicates and imports nothing new', () => {
    const env = runJson(dbB, ['import', bundleFile])
    expect(env.ok).toBe(true)
    const data = env.data as { imported: { facts: number }; skippedDuplicates: number }
    expect(data.imported.facts).toBe(0)
    expect(data.skippedDuplicates).toBeGreaterThan(0)
  }, 15_000)

  it('doctor --json reports the second DB is ok', () => {
    const env = runJson(dbB, ['doctor'])
    expect(env.ok).toBe(true)
    const data = env.data as { ok: boolean; problems: unknown[] }
    expect(data.ok).toBe(true)
    expect(data.problems).toHaveLength(0)
  }, 15_000)

  it('backup produces a standalone snapshot file with verified counts', () => {
    const env = runJson(dbA, ['backup', backupFile])
    expect(env.ok).toBe(true)
    expect(existsSync(backupFile)).toBe(true)
    expect(statSync(backupFile).size).toBeGreaterThan(0)
    const data = env.data as { verified: boolean; counts: { facts: number } }
    expect(data.verified).toBe(true)
    expect(data.counts.facts).toBe(2)
  }, 15_000)
})

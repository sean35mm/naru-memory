/**
 * Offline benchmarks for Milestone 3 (plan §21.6) — a SCRIPT, not a CI gate.
 *
 * Seeds N facts across several scopes into a temp on-disk SQLite DB using the
 * deterministic offline MockEmbedder (NO network), then measures and prints:
 *   - ingest latency (per-fact add)
 *   - search p50/p95 (hybrid scope-safe search)
 *   - context.build p50/p95 (token-budget packing)
 *   - reindex time (drop + re-embed every active fact, plan §12.2)
 *   - DB size on disk (db + WAL + SHM)
 *   - approximate process memory (RSS / heapUsed)
 *
 * Sizes: tiny (50), 1k, 10k. Run via `pnpm bench`. Date.now() is used here because
 * this is application/script code (allowed) — never in workflow/test-harness code.
 *
 * Usage:
 *   pnpm bench               # tiny + 1k (+ 10k only if it finishes < ~60s)
 *   pnpm bench tiny 1k 10k   # explicit sizes
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Naru } from '@naru/core'
import type { WritableScopeSelector } from '@naru/core'

/** Named benchmark sizes (plan §21.6). */
const SIZES: Record<string, number> = { tiny: 50, '1k': 1000, '10k': 10000 }

/** Scopes the synthetic corpus is spread across (exercises scope-filtered KNN). */
const SCOPES: WritableScopeSelector[] = [
  { type: 'project', key: 'web-app' },
  { type: 'project', key: 'api-svc' },
  { type: 'user', key: 'alice' },
  { type: 'session', key: 'sess-1' },
]

/** A small vocabulary so generated statements share tokens (realistic overlap). */
const SUBJECTS = ['service', 'worker', 'pipeline', 'client', 'scheduler', 'cache', 'router']
const VERBS = ['retries', 'deploys', 'caches', 'validates', 'streams', 'batches', 'compresses']
const OBJECTS = ['requests', 'payloads', 'records', 'tokens', 'events', 'sessions', 'metrics']
const QUALIFIERS = ['nightly', 'on failure', 'with backoff', 'in parallel', 'under load']

/** Deterministic synthetic statement for fact index `i` (no randomness). */
function statementFor(i: number): string {
  const s = SUBJECTS[i % SUBJECTS.length]
  const v = VERBS[(i * 3) % VERBS.length]
  const o = OBJECTS[(i * 5) % OBJECTS.length]
  const q = QUALIFIERS[(i * 7) % QUALIFIERS.length]
  return `The ${s} ${v} ${o} ${q} for run ${i}`
}

/** A handful of representative queries (sampled — keep runtime reasonable). */
const QUERIES = [
  'service retries requests on failure',
  'worker deploys payloads nightly',
  'pipeline caches records in parallel',
  'client validates tokens under load',
  'scheduler streams events with backoff',
]

/** p-th percentile (0..100) of a sample, nearest-rank. */
function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) {
    return 0
  }
  const rank = Math.ceil((p / 100) * sortedMs.length)
  const idx = Math.min(sortedMs.length - 1, Math.max(0, rank - 1))
  return sortedMs[idx] ?? 0
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(2)}ms`
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Sum the on-disk size of the SQLite DB plus its WAL/SHM sidecar files. */
function dbSizeBytes(dbPath: string): number {
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(`${dbPath}${suffix}`).size
    } catch {
      // sidecar may not exist (e.g. checkpointed) — ignore.
    }
  }
  return total
}

interface SizeResult {
  size: number
  ingestTotalMs: number
  ingestPerFactMs: number
  searchP50: number
  searchP95: number
  contextP50: number
  contextP95: number
  reindexMs: number
  dbBytes: number
  rssBytes: number
  heapBytes: number
  facts: number
}

/** Run one size: seed, measure, and tear down its temp DB. */
async function runSize(n: number): Promise<SizeResult> {
  const dir = mkdtempSync(join(tmpdir(), 'naru-bench-'))
  const dbPath = join(dir, 'bench.db')
  const naru = Naru.open({ db: dbPath, embeddings: { provider: 'mock' } })

  try {
    // --- ingest: per-fact add latency ----------------------------------
    const ingestStart = Date.now()
    for (let i = 0; i < n; i++) {
      const scope = SCOPES[i % SCOPES.length] ?? SCOPES[0]
      naru.addMemory({ text: statementFor(i), scope: scope as WritableScopeSelector })
    }
    const ingestTotalMs = Date.now() - ingestStart

    // Deterministically embed all facts (addMemory embeds fire-and-forget; this
    // awaitable backfill also stands in for the reindex timing below).
    const reindexStart = Date.now()
    await naru.reindexVectors()
    const reindexMs = Date.now() - reindexStart

    // --- search p50/p95 -------------------------------------------------
    const searchSamples: number[] = []
    const REPEAT = n >= 10000 ? 10 : 40
    for (let r = 0; r < REPEAT; r++) {
      for (const q of QUERIES) {
        const scope = SCOPES[(r + searchSamples.length) % SCOPES.length] ?? SCOPES[0]
        const t = Date.now()
        await naru.searchHybrid({ scopes: [scope as WritableScopeSelector], query: q, limit: 10 })
        searchSamples.push(Date.now() - t)
      }
    }
    searchSamples.sort((a, b) => a - b)

    // --- context.build p50/p95 -----------------------------------------
    const contextSamples: number[] = []
    for (let r = 0; r < REPEAT; r++) {
      for (const q of QUERIES) {
        const scope = SCOPES[(r + contextSamples.length) % SCOPES.length] ?? SCOPES[0]
        const t = Date.now()
        await naru.buildContext({
          scopes: [scope as WritableScopeSelector],
          query: q,
          limit: 10,
          tokenBudget: 1024,
        })
        contextSamples.push(Date.now() - t)
      }
    }
    contextSamples.sort((a, b) => a - b)

    const facts = naru.status().counts.facts
    const dbBytes = dbSizeBytes(dbPath)
    const mem = process.memoryUsage()

    // Let any in-flight fire-and-forget embeds settle before we close so they
    // never hit a closed connection (addMemory embeds after its sync commit).
    await new Promise((resolve) => setImmediate(resolve))

    return {
      size: n,
      ingestTotalMs,
      ingestPerFactMs: ingestTotalMs / n,
      searchP50: percentile(searchSamples, 50),
      searchP95: percentile(searchSamples, 95),
      contextP50: percentile(contextSamples, 50),
      contextP95: percentile(contextSamples, 95),
      reindexMs,
      dbBytes,
      rssBytes: mem.rss,
      heapBytes: mem.heapUsed,
      facts,
    }
  } finally {
    naru.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function printResult(label: string, r: SizeResult): void {
  const log = console.log
  log(`\n=== ${label} (${r.size} facts, ${r.facts} stored) ===`)
  log(`  ingest:        ${fmtMs(r.ingestTotalMs)} total  (${fmtMs(r.ingestPerFactMs)}/fact)`)
  log(`  search:        p50 ${fmtMs(r.searchP50)}   p95 ${fmtMs(r.searchP95)}`)
  log(`  context.build: p50 ${fmtMs(r.contextP50)}   p95 ${fmtMs(r.contextP95)}`)
  log(`  reindex:       ${fmtMs(r.reindexMs)}`)
  log(`  db size:       ${fmtBytes(r.dbBytes)}`)
  log(`  memory:        rss ${fmtBytes(r.rssBytes)}   heapUsed ${fmtBytes(r.heapBytes)}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a in SIZES)
  // Default: tiny + 1k; attempt 10k and bail if it overruns the soft budget.
  const requested = args.length > 0 ? args : ['tiny', '1k']
  const includeTenK = args.length > 0 ? args.includes('10k') : true

  console.log('Naru Memory benchmarks (plan §21.6) — MockEmbedder, offline, temp DB')

  for (const name of requested) {
    if (name === '10k' && args.length === 0) {
      continue
    }
    const n = SIZES[name]
    if (n === undefined) {
      continue
    }
    printResult(name, await runSize(n))
  }

  // Opportunistic 10k when not explicitly requested: run it but abort the print
  // if it exceeds the ~60s soft budget (plan §21.6 "keep runtime reasonable").
  if (includeTenK && args.length === 0) {
    const SOFT_BUDGET_MS = 60_000
    const start = Date.now()
    const result = await runSize(SIZES['10k'] as number)
    const elapsed = Date.now() - start
    if (elapsed <= SOFT_BUDGET_MS) {
      printResult('10k', result)
    } else {
      console.log(`\n=== 10k skipped from report: ran ${fmtMs(elapsed)} > 60s soft budget ===`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

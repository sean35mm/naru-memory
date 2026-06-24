import type { Store } from '@naru/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { IntegrityProblem, IntegrityProblemKind } from './integrity'
import { Naru } from './naru'

/** Reach the embedded store for direct row manipulation (test-only). */
function storeOf(naru: Naru): Store {
  return (naru as unknown as { store: Store }).store
}

/** Find a reported problem by kind, or undefined. */
function problem(
  problems: IntegrityProblem[],
  kind: IntegrityProblemKind,
): IntegrityProblem | undefined {
  return problems.find((p) => p.kind === kind)
}

/**
 * Run `fn` with the connection's `foreign_keys` pragma temporarily OFF. This is
 * how the tests fabricate the referential drift that `checkIntegrity` exists to
 * catch (an orphaned derived/reference row that a crash or partial purge could
 * leave behind): SQLite would otherwise refuse the orphaning delete/insert.
 */
function withForeignKeysOff(store: Store, fn: () => void): void {
  store.db.pragma('foreign_keys = OFF')
  try {
    fn()
  } finally {
    store.db.pragma('foreign_keys = ON')
  }
}

/**
 * checkIntegrity flags directly-inserted orphan/drift rows by kind + count, and
 * NEVER leaks fact/episode/evidence/entity TEXT into the report (plan §22, §18).
 */
describe('checkIntegrity detects orphan and drift rows (plan §22)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  it('flags an orphaned fact_vector (fact deleted out from under it)', async () => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    const scope = { type: 'project' as const, key: 'app' }
    const fact = naru.addMemory({ scope, text: 'The deploy runbook lives in the ops wiki' })
    await naru.reindexVectors()
    const store = storeOf(naru)
    expect(store.vectors.getVector(fact.id)).toBeDefined()

    // Delete the canonical fact row directly, leaving its vector behind (FK
    // cascade would normally drop the vector — turn the pragma off to orphan it).
    withForeignKeysOff(store, () => {
      store.db.prepare('DELETE FROM facts WHERE id = ?').run(fact.id)
    })

    const report = naru.checkIntegrity()
    expect(report.ok).toBe(false)
    const p = problem(report.problems, 'orphan_fact_vectors')
    expect(p).toBeDefined()
    expect(p?.count).toBe(1)
    expect(p?.sampleIds).toContain(fact.id)
  })

  it('flags orphaned evidence whose fact is missing, without leaking the quote', () => {
    naru = Naru.open({ db: ':memory:' })
    const scope = { type: 'project' as const, key: 'app' }
    const secret = 'CLASSIFIED EVIDENCE QUOTE about the user'
    // Capture an episode + manual fact, then attach evidence with a quote.
    const fact = naru.addMemory({ scope, text: 'A fact that will be orphaned' })
    const store = storeOf(naru)
    const episode = store.episodes.insert({
      id: 'ep-orphan-test',
      scopeId: store.scopes.list()[0]?.id ?? '',
      sourceType: 'manual',
      sourceRef: null,
      sourceHash: 'sourcehash-orphan',
      hmacHash: null,
      retentionMode: 'redacted',
      redactedText: secret,
      metadata: {},
      observedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    })
    store.evidence.insert({
      id: 'ev-orphan-test',
      factId: fact.id,
      episodeId: episode.id,
      spanStart: null,
      spanEnd: null,
      redactedQuote: secret,
      quoteHash: 'quotehash-orphan',
      extractorName: 'manual',
      extractorVersion: '1',
      createdAt: new Date().toISOString(),
    })

    // Orphan the evidence by deleting its fact (FK off so the orphan survives).
    withForeignKeysOff(store, () => {
      store.db.prepare('DELETE FROM facts WHERE id = ?').run(fact.id)
    })

    const report = naru.checkIntegrity()
    expect(report.ok).toBe(false)
    const p = problem(report.problems, 'orphan_evidence_fact')
    expect(p).toBeDefined()
    // addManual also auto-creates an evidence row for the fact, so deleting the
    // fact orphans both that row and the manually-inserted one — count >= 1 and
    // the explicit evidence id is present in the sample.
    expect(p?.count).toBeGreaterThanOrEqual(1)
    expect(p?.sampleIds).toContain('ev-orphan-test')

    // Privacy: the secret quote/text must not appear anywhere in the report.
    const json = JSON.stringify(report)
    expect(json.includes(secret)).toBe(false)
    expect(json.includes('CLASSIFIED')).toBe(false)
  })

  it('flags facts_fts membership drift (extra and missing rows)', () => {
    naru = Naru.open({ db: ':memory:' })
    const scope = { type: 'project' as const, key: 'app' }
    const fact = naru.addMemory({ scope, text: 'A fact whose FTS row is removed' })
    const store = storeOf(naru)

    // Remove the canonical fact's FTS row -> "missing" drift.
    store.db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(fact.id)
    // Insert an FTS row for a non-existent fact -> "extra" drift.
    store.db
      .prepare(
        `INSERT INTO facts_fts (fact_id, statement, predicate, entity_text, scope_key)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('ghost-fact-id', 'ghost statement', 'states', '', 'project:app')

    const report = naru.checkIntegrity()
    expect(report.ok).toBe(false)
    expect(problem(report.problems, 'facts_fts_missing')?.sampleIds).toContain(fact.id)
    expect(problem(report.problems, 'facts_fts_extra')?.sampleIds).toContain('ghost-fact-id')
  })

  it('flags a dangling entity link on a fact (entity removed)', () => {
    naru = Naru.open({ db: ':memory:' })
    const scope = { type: 'project' as const, key: 'app' }
    const fact = naru.addMemory({
      scope,
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    const store = storeOf(naru)
    const subjectId = store.facts.getById(fact.id)?.subjectEntityId
    expect(subjectId).toBeTruthy()

    // Delete the linked entity directly, leaving the fact's column dangling.
    withForeignKeysOff(store, () => {
      store.db.prepare('DELETE FROM entities WHERE id = ?').run(subjectId)
    })

    const report = naru.checkIntegrity()
    expect(report.ok).toBe(false)
    const p = problem(report.problems, 'dangling_entity_link')
    expect(p?.count).toBe(1)
    expect(p?.sampleIds).toContain(fact.id)
  })

  it('flags an orphaned supersession pointing at a missing fact', () => {
    naru = Naru.open({ db: ':memory:' })
    const scope = { type: 'project' as const, key: 'app' }
    const oldFact = naru.addMemory({ scope, text: 'The old value is A' })
    const newFact = naru.addMemory({ scope, text: 'The new value is B' })
    naru.supersede(oldFact.id, newFact.id, 'changed')
    const store = storeOf(naru)
    expect(store.supersessions.listByOld(oldFact.id).length).toBe(1)

    // Delete the new fact, orphaning the supersession's new_fact_id.
    withForeignKeysOff(store, () => {
      store.db.prepare('DELETE FROM facts WHERE id = ?').run(newFact.id)
    })

    const report = naru.checkIntegrity()
    expect(report.ok).toBe(false)
    expect(problem(report.problems, 'orphan_supersessions')?.count).toBe(1)
  })
})

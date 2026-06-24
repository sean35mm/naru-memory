import type { Store } from '@naru/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

function storeOf(naru: Naru): Store {
  return (naru as unknown as { store: Store }).store
}

function count(naru: Naru, table: string): number {
  const row = storeOf(naru).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

describe('bundle dedupe on reimport (plan §19)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  it('importing the same bundle twice into one DB creates no duplicate facts/episodes', async () => {
    const source = Naru.open({ db: ':memory:' })
    source.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    source.addMemory({ scope: { type: 'user', key: 'alice' }, text: 'Alice likes coffee' })
    const bundle = source.exportBundle()
    source.close()

    naru = Naru.open({ db: ':memory:' })

    const first = await naru.importBundle(bundle)
    expect(first.skippedDuplicates).toBe(0)
    const factsAfterFirst = count(naru, 'facts')
    const episodesAfterFirst = count(naru, 'episodes')
    const entitiesAfterFirst = count(naru, 'entities')
    const scopesAfterFirst = count(naru, 'scopes')

    const second = await naru.importBundle(bundle)

    // Second import is a pure no-op on canonical rows: everything deduped.
    expect(second.imported.facts).toBe(0)
    expect(second.imported.episodes).toBe(0)
    expect(second.imported.entities).toBe(0)
    expect(second.imported.scopes).toBe(0)
    expect(second.skippedDuplicates).toBeGreaterThan(0)

    expect(count(naru, 'facts')).toBe(factsAfterFirst)
    expect(count(naru, 'episodes')).toBe(episodesAfterFirst)
    expect(count(naru, 'entities')).toBe(entitiesAfterFirst)
    expect(count(naru, 'scopes')).toBe(scopesAfterFirst)
  })

  it('dedupes facts by statement_hash within scope (portable identity, not raw id)', async () => {
    // Two independent stores that each add the SAME logical fact get the SAME
    // portable statement_hash, so importing one into the other dedupes it.
    const a = Naru.open({ db: ':memory:' })
    a.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    const bundleA = a.exportBundle()
    a.close()

    naru = Naru.open({ db: ':memory:' })
    // Independently create the same fact (different row id, same statement_hash).
    naru.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    const factsBefore = count(naru, 'facts')

    const result = await naru.importBundle(bundleA)
    expect(result.imported.facts).toBe(0)
    expect(result.skippedDuplicates).toBeGreaterThan(0)
    expect(count(naru, 'facts')).toBe(factsBefore)
  })

  it('merges a case-variant fact across machines without aborting (plan §11.5/§19)', async () => {
    // Machine A captures the fact with one casing; machine B independently has
    // the SAME logical fact with DIFFERENT casing. statement_hash is casefold-
    // normalized (portable) so both share a hash, but the stored `statement`
    // preserves original casing and differs. The active-hash UNIQUE index allows
    // only one active row per (scope, statement_hash); dedupe must key on the
    // portable hash (not the raw statement) so this merges instead of throwing
    // `UNIQUE constraint failed` and rolling back the WHOLE import.
    const machineA = Naru.open({ db: ':memory:' })
    machineA.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'Alice prefers Dark Mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'Dark Mode',
    })
    const bundleA = machineA.exportBundle()
    machineA.close()

    naru = Naru.open({ db: ':memory:' })
    naru.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'alice PREFERS dark mode',
      subject: 'alice',
      predicate: 'PREFERS',
      object: 'dark mode',
    })
    // Also add an unrelated fact so we can prove the whole import did not roll back.
    naru.addMemory({ scope: { type: 'user', key: 'alice' }, text: 'Alice likes coffee' })
    const factsBefore = count(naru, 'facts')

    const result = await naru.importBundle(bundleA)

    // The case-variant fact deduped on its portable hash (no second active row);
    // no conflict, no rollback — facts stay exactly as before the import.
    expect(result.skippedDuplicates).toBeGreaterThan(0)
    expect(result.skippedConflicts).toBe(0)
    expect(result.imported.facts).toBe(0)
    expect(count(naru, 'facts')).toBe(factsBefore)
  })

  it('degrades an adversarial (scope,hash) active collision to a skip, not a rollback', async () => {
    // A hand-edited/tampered bundle whose active fact carries a statement_hash
    // that collides with a DIFFERENT destination active fact's hash. dedupe on
    // (scope, statement_hash) treats it as the same logical fact and remaps it —
    // the surviving destination row is untouched, the import is NOT aborted, and
    // no second active row violates idx_facts_active_hash.
    naru = Naru.open({ db: ':memory:' })
    const keep = naru.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'The staging host is staging.example.com',
    })
    const destStore = storeOf(naru)
    const keepRow = destStore.facts.getById(keep.id)
    expect(keepRow).toBeDefined()

    // Build a bundle whose active fact shares the destination row's
    // (scope, statement_hash) but has a different statement + id.
    const bundle = naru.exportBundle()
    const collidingFact = {
      ...(keepRow as NonNullable<typeof keepRow>),
      id: 'fact_tampered000000000000000',
      statement: 'A DIFFERENT statement that should not resurrect',
    }
    const tampered = { ...bundle, facts: [collidingFact] }
    const factsBefore = count(naru, 'facts')

    const result = await naru.importBundle(tampered)

    // The conflicting active row was deduped/remapped (not inserted); the
    // destination's existing row survived and the table did not grow.
    expect(result.imported.facts).toBe(0)
    expect(count(naru, 'facts')).toBe(factsBefore)
    expect(destStore.facts.getById(keep.id)).toBeDefined()
  })
})

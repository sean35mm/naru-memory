import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

describe('supersession (plan §13.6, §14.3)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
  })

  afterEach(() => {
    naru.close()
  })

  it('current view returns the new fact; history shows both', () => {
    const scope = { type: 'project' as const, key: 'app' }
    const oldFact = naru.addMemory({ text: 'The project uses Jest for testing.', scope })
    const newFact = naru.addMemory({ text: 'The project uses Vitest for testing.', scope })

    naru.supersede(oldFact.id, newFact.id, 'switched test runner')

    // Default search / current view returns NEW only.
    const current = naru.search({ query: 'testing', scope })
    const currentIds = current.map((r) => r.factId)
    expect(currentIds).toContain(newFact.id)
    expect(currentIds).not.toContain(oldFact.id)

    // includeHistory surfaces both.
    const withHistory = naru.search({ query: 'testing', scope, includeHistory: true })
    const historyIds = withHistory.map((r) => r.factId)
    expect(historyIds).toContain(newFact.id)
    expect(historyIds).toContain(oldFact.id)

    // history() returns the chain.
    const chain = naru.history(newFact.id)
    const chainIds = chain.map((e) => e.fact.id)
    expect(chainIds).toEqual([oldFact.id, newFact.id])
    expect(chain[0]?.supersededBy).toBe(newFact.id)
    expect(chain[1]?.supersedes).toBe(oldFact.id)
  })

  it('re-adding a superseded statement does not resurrect it or duplicate active rows', () => {
    const scope = { type: 'project' as const, key: 'app' }
    const oldFact = naru.addMemory({ text: 'The project uses Jest for testing.', scope })
    const newFact = naru.addMemory({ text: 'The project uses Vitest for testing.', scope })
    naru.supersede(oldFact.id, newFact.id, 'switched test runner')

    // Re-adding the exact superseded text returns the active replacement, not a
    // fresh active duplicate (plan §13.5/§13.6).
    const readded = naru.addMemory({ text: 'The project uses Jest for testing.', scope })
    expect(readded.id).toBe(newFact.id)

    // No second active row shares the old statement_hash.
    const active = naru.list({ scope, status: 'active' })
    const activeSharingOldHash = active.filter((f) => f.statementHash === oldFact.statementHash)
    expect(activeSharingOldHash).toHaveLength(0)

    // The old statement stays out of the current view.
    const current = naru.search({ query: 'testing', scope }).map((r) => r.factId)
    expect(current).not.toContain(oldFact.id)
    expect(current).toContain(newFact.id)
  })
})

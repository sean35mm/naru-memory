import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * Supersession via the SEMANTIC tier (plan §13.6). The MockExtractor's
 * deterministic `reconcile` returns `supersedes` when a candidate shares the
 * subject+predicate of a related active fact but changes the object.
 */
describe('supersession by extraction (plan §13.6)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', llm: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('a changed object supersedes the old fact; current view = the new fact', async () => {
    const scope = { type: 'project' as const, key: 'app' }

    // (Auth, uses, cookies) -> active.
    const first = await naru.capture({ text: 'Auth uses cookies.', scope })
    expect(first.facts).toHaveLength(1)
    const oldFact = first.facts[0]
    expect(oldFact).toBeDefined()

    // (Auth, uses, JWT) -> same subject/predicate, changed object -> supersedes.
    const second = await naru.capture({ text: 'Auth uses JWT.', scope })
    expect(second.facts).toHaveLength(1)
    const newFact = second.facts[0]
    expect(newFact).toBeDefined()
    expect(newFact?.id).not.toBe(oldFact?.id)

    // Current view returns only the new (JWT) fact.
    const current = naru.list({ scope, status: 'active' })
    const currentStatements = current.map((f) => f.statement)
    expect(currentStatements).toContain('Auth uses JWT')
    expect(currentStatements).not.toContain('Auth uses cookies')

    // The old fact is marked superseded and search hides it by default.
    const oldRow = naru.get(oldFact?.id ?? '')
    expect(oldRow?.fact.status).toBe('superseded')
    const searched = naru.search({ query: 'Auth', scope }).map((r) => r.factId)
    expect(searched).toContain(newFact?.id)
    expect(searched).not.toContain(oldFact?.id)

    // History links the two facts as a supersession chain.
    const chain = naru.history(newFact?.id ?? '')
    expect(chain.map((e) => e.fact.id)).toEqual([oldFact?.id, newFact?.id])
  })

  it('two identical supersedes candidates in one capture never crash (plan §13.3)', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    await naru.capture({ text: 'Auth uses cookies.', scope })

    // A single capture emitting two semantically identical candidates that both
    // reconcile to `supersedes` must NOT violate the partial active-hash unique
    // index — capture resolves, the episode survives, and at most one active row
    // per (scope, statement_hash) is kept.
    const res = await naru.capture({ text: 'Auth uses JWT. Auth uses JWT.', scope })
    expect(res.episode).toBeDefined()
    const active = naru.list({ scope, status: 'active' }).map((f) => f.statement)
    expect(active).toContain('Auth uses JWT')
    expect(active).not.toContain('Auth uses cookies')
    expect(active.filter((s) => s.startsWith('Auth uses'))).toHaveLength(1)
  })

  it('two distinct supersedes of the same attribute chain into one active head (plan §13.6)', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    await naru.capture({ text: 'Auth uses cookies.', scope })

    // Both 'JWT' and 'OAuth' share subject+predicate with the prior 'cookies'
    // fact and are independently judged `supersedes` against it. They must form a
    // single chain (cookies -> JWT -> OAuth) rather than leaving two conflicting
    // active facts with one dropped supersession link.
    await naru.capture({ text: 'Auth uses JWT. Auth uses OAuth.', scope })
    const active = naru.list({ scope, status: 'active' }).map((f) => f.statement)
    expect(active.filter((s) => s.startsWith('Auth uses'))).toHaveLength(1)
  })
})

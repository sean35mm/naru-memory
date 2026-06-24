import { Naru } from '@naru/core'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type NaruContext, appRouter } from './index'
import { createCallerFactory } from './trpc'

const createCaller = createCallerFactory(appRouter)

/** Build an in-process caller over a fresh in-memory Naru (no HTTP). */
function callerFor(naru: Naru, authed = true) {
  const ctx: NaruContext = { naru, authed }
  return createCaller(ctx)
}

describe('@naru/api appRouter (plan §15)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
  })

  afterEach(() => {
    naru.close()
  })

  it('memory.add then memory.search returns it within the same scope', async () => {
    const caller = callerFor(naru)
    const scope = { type: 'project' as const, key: 'app' }

    const fact = await caller.memory.add({
      text: 'The API rate limit is 100 requests per minute.',
      scope,
    })
    expect(fact.id).toMatch(/^fact_/)

    const results = await caller.memory.search({ query: 'rate limit', scope })
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.factId === fact.id)).toBe(true)
    // §9.4: a bare search with no scope/global resolves to the empty set.
    const bare = await caller.memory.search({ query: 'rate limit' })
    expect(bare).toEqual([])
  })

  it('fact.get returns NOT_FOUND for a bogus id', async () => {
    const caller = callerFor(naru)
    await expect(caller.fact.get({ id: 'fact_does_not_exist' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('fact.get returns the fact with evidence for a real id', async () => {
    const caller = callerFor(naru)
    const scope = { type: 'project' as const, key: 'app' }
    const fact = await caller.memory.add({ text: 'Deploys happen on Fridays.', scope })

    const got = await caller.fact.get({ id: fact.id })
    expect(got.fact.id).toBe(fact.id)
    expect(got.evidence.length).toBeGreaterThan(0)
  })

  it('scope.list reflects scopes created by writes', async () => {
    const caller = callerFor(naru)
    const before = await caller.scope.list()
    expect(before).toEqual([])

    await caller.memory.add({ text: 'x', scope: { type: 'user', key: 'sean' } })
    const after = await caller.scope.list()
    expect(after.map((s) => s.key)).toContain('user:sean')
  })

  it('system.status reports db path, counts, retention mode, and feature seams', async () => {
    const caller = callerFor(naru)
    const status = await caller.system.status()
    expect(status.dbPath).toBe(':memory:')
    expect(status.retentionMode).toBe('redacted')
    expect(status.counts).toMatchObject({ facts: 0, entities: 0, episodes: 0, scopes: 0 })
    expect(status.features).toEqual({
      extractor: { available: false },
      // No embedder configured -> vector retrieval OFF; backend seam still reported.
      vector: { backend: 'bruteforce', embedder: { available: false } },
      server: 'embedded',
    })
  })

  it('an authed procedure throws UNAUTHORIZED when context is not authed', async () => {
    const caller = callerFor(naru, false)
    await expect(caller.system.status()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(caller.scope.list()).rejects.toBeInstanceOf(TRPCError)
  })

  it('context.build assembles items, a prompt block, and a token estimate', async () => {
    const caller = callerFor(naru)
    const scope = { type: 'project' as const, key: 'app' }
    await caller.memory.add({ text: 'Prefer pnpm over npm in this repo.', scope })

    const ctx = await caller.context.build({ query: 'pnpm', scope })
    expect(ctx.items.length).toBeGreaterThan(0)
    expect(ctx.promptBlock).toContain('pnpm')
    expect(ctx.tokenEstimate).toBe(Math.ceil(ctx.promptBlock.length / 4))
  })

  it('entity.list / entity.get expose linked active facts; bogus id is NOT_FOUND', async () => {
    const caller = callerFor(naru)
    const scope = { type: 'project' as const, key: 'app' }
    await caller.memory.add({
      text: 'links Postgres',
      scope,
      subject: 'Service',
      predicate: 'uses',
      object: 'Postgres',
    })

    const entities = await caller.entity.list({ scope })
    expect(entities.length).toBeGreaterThan(0)
    const first = entities[0]
    if (!first) {
      throw new Error('expected at least one entity')
    }
    const detail = await caller.entity.get({ id: first.id })
    expect(detail.entity.id).toBe(first.id)
    expect(detail.facts.every((f) => f.status === 'active')).toBe(true)

    await expect(caller.entity.get({ id: 'ent_bogus' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('index.status reports the known derived indexes and rebuild succeeds', async () => {
    const caller = callerFor(naru)
    const status = await caller.index.status()
    expect(status.map((s) => s.indexName).sort()).toEqual(['entities_fts', 'facts_fts'])
    const rebuilt = await caller.index.rebuild()
    expect(rebuilt).toEqual({ ok: true })
  })

  it('scope.resolve rejects the global alias as a write target (§9.1)', async () => {
    const caller = callerFor(naru)
    // `global` is a query-time alias, never a stored row -> input validation rejects it.
    await expect(
      // @ts-expect-error global is intentionally excluded from the resolvable set
      caller.scope.resolve({ type: 'global', key: 'x' }),
    ).rejects.toBeInstanceOf(TRPCError)
  })

  it('memory.add and episode.capture reject scope.type==="global" without creating a row (§9.1, §9.2)', async () => {
    const caller = callerFor(naru)
    await expect(
      // @ts-expect-error global is excluded from the writable scope selector
      caller.memory.add({ text: 'should not persist', scope: { type: 'global', key: 'x' } }),
    ).rejects.toBeInstanceOf(TRPCError)
    await expect(
      caller.episode.capture({
        text: 'should not persist',
        // @ts-expect-error global is excluded from the writable scope selector
        scope: { type: 'global', key: 'x' },
        sourceType: 'manual',
      }),
    ).rejects.toBeInstanceOf(TRPCError)
    // No `global` scope row may have leaked in via either write path.
    const scopes = await caller.scope.list()
    expect(scopes.some((s) => s.type === 'global')).toBe(false)
  })
})

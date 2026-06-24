import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/**
 * `context.build` token-budget packing (plan §14.4): run the hybrid scope-safe
 * search, then greedily pack top-ranked items into a prompt block within a token
 * budget (default 1024, estimated ~ceil(chars/4)). The returned token estimate
 * never exceeds the budget; items carry their per-signal reasons; an empty
 * allowed-scope set yields an empty result (§9.4 fail-safe).
 */
describe('context.build packing (plan §14.4)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
  })

  afterEach(() => {
    naru.close()
  })

  it('packs items, carries reasons, and reports a matching token estimate', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({ text: 'Prefer pnpm over npm in this repo', scope })
    await naru.reindexVectors()

    const ctx = await naru.buildContext({ query: 'pnpm package manager', scope })
    expect(ctx.items.length).toBeGreaterThan(0)
    expect(ctx.promptBlock).toContain('pnpm')
    // The estimate is exactly ceil(chars/4) of the assembled block.
    expect(ctx.tokenEstimate).toBe(Math.ceil(ctx.promptBlock.length / 4))
    // Every packed item exposes its per-signal reason (plan §14.4 inspectable).
    for (const item of ctx.items) {
      expect(Array.isArray(item.reason)).toBe(true)
      expect(item.reason.length).toBeGreaterThan(0)
      expect(item.scope).toBe('project:app')
    }
  })

  it('never exceeds the token budget and stops packing at the limit', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    // Many longish facts that all match the query lexically.
    for (let i = 0; i < 40; i++) {
      naru.addMemory({
        text: `Deployment runbook step ${i}: run the migration then restart the service worker pool carefully`,
        scope,
      })
    }
    await naru.reindexVectors()

    const budget = 40
    const ctx = await naru.buildContext({
      query: 'deployment runbook migration restart service worker',
      scope,
      limit: 40,
      tokenBudget: budget,
    })
    // Hard guarantee: the assembled block fits the budget.
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(budget)
    expect(Math.ceil(ctx.promptBlock.length / 4)).toBeLessThanOrEqual(budget)
    // It actually had to drop items (more matched than fit), proving packing.
    expect(ctx.items.length).toBeLessThan(40)
    expect(ctx.items.length).toBeGreaterThan(0)
  })

  it('returns an empty result when no scope is allowed (plan §9.4 fail-safe)', async () => {
    naru.addMemory({ text: 'A fact in a real scope', scope: { type: 'project', key: 'app' } })
    await naru.reindexVectors()

    // No scope and no global -> empty allowed set -> empty context.
    const ctx = await naru.buildContext({ query: 'fact' })
    expect(ctx.items).toEqual([])
    expect(ctx.promptBlock).toBe('')
    expect(ctx.tokenEstimate).toBe(0)
  })

  it('a budget too small for even one item yields an empty block, not an orphan header', async () => {
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({
      text: 'This statement is intentionally far too long to ever fit into a one token budget',
      scope,
    })
    await naru.reindexVectors()

    const ctx = await naru.buildContext({
      query: 'statement long fit budget',
      scope,
      tokenBudget: 1,
    })
    expect(ctx.items).toEqual([])
    expect(ctx.promptBlock).toBe('')
    expect(ctx.tokenEstimate).toBe(0)
  })
})

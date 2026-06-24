import { Naru } from '@naru/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AdapterClient, EmbeddedAdapterClient } from './client'
import type { GitRunner } from './scope'
import { resolveScopes } from './scope'
import { createTools } from './tools'
import type { PluginContext, ToolContext, ToolDefinition } from './types'

/**
 * Tools-against-embedded-Naru integration (plan §17.3, §21.5).
 *
 * Drives the native tools through an {@link EmbeddedAdapterClient} over a real
 * `:memory:` Naru — no OpenCode runtime, no server, no network. A fixed
 * {@link GitRunner} pins the resolved scopes so writes land in (and reads honor)
 * a deterministic `project` scope.
 */

/** Fixed git runner: every session resolves to project `acme/widgets` on `main`. */
const fixedGit: GitRunner = {
  remoteUrl: () => 'git@github.com:acme/widgets.git',
  topLevel: () => '/work/widgets',
  currentBranch: () => 'main',
}

/** Tool execution context for a session in `/work/widgets`. */
const toolCtx: ToolContext = { cwd: '/work/widgets', sessionId: 'sess-1', agentId: 'claude' }

function toolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]))
}

describe('native tools against an embedded :memory: Naru (plan §17.3)', () => {
  let naru: Naru
  let client: AdapterClient
  let tools: Map<string, ToolDefinition>

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
    client = new EmbeddedAdapterClient(naru)
    const ctx: PluginContext = {
      client,
      resolveScopes: (input) => resolveScopes(input, fixedGit),
    }
    tools = toolMap(createTools(ctx))
  })

  afterEach(async () => {
    await client.close()
  })

  it('exposes exactly the eight native tools (§17.3)', () => {
    expect([...tools.keys()].sort()).toEqual(
      [
        'add_memory',
        'build_memory_context',
        'forget_memory',
        'get_memories',
        'get_memory',
        'list_entities',
        'memory_status',
        'search_memories',
      ].sort(),
    )
  })

  it('add_memory then search_memories returns it within the resolved scope', async () => {
    const add = tools.get('add_memory') as ToolDefinition<{
      fact: { id: string }
      scope: string
    }>
    const added = await add.execute(
      { text: 'The deploy command for widgets is pnpm deploy widgets.' },
      toolCtx,
    )
    // Default write scope is `project` -> acme/widgets (plan §9.2, §17.5).
    expect(added.scope).toBe('project:acme/widgets')

    const search = tools.get('search_memories') as ToolDefinition<{
      results: { factId: string; scope: string; statement: string }[]
      count: number
    }>
    const found = await search.execute({ query: 'deploy command widgets' }, toolCtx)
    expect(found.count).toBeGreaterThan(0)
    expect(found.results.some((r) => r.factId === added.fact.id)).toBe(true)
    // Scope-safe: results are confined to the resolved scope set (§9.4).
    expect(found.results.every((r) => r.scope === 'project:acme/widgets')).toBe(true)
  })

  it('a redacted secret in add_memory is stored redacted (§18.1)', async () => {
    const add = tools.get('add_memory') as ToolDefinition<{ fact: { id: string } }>
    const secret = 'sk-abcDEF0123456789abcdef0123'
    const added = await add.execute({ text: `The OpenAI key is ${secret} keep it safe.` }, toolCtx)

    // The stored fact must not contain the raw secret; core redacts before
    // persistence — the adapter relies on it and never bypasses it.
    const get = tools.get('get_memory') as ToolDefinition<{
      found: boolean
      fact?: { statement: string }
    }>
    const got = await get.execute({ id: added.fact.id }, toolCtx)
    expect(got.found).toBe(true)
    expect(got.fact?.statement).not.toContain(secret)
    expect(got.fact?.statement).toContain('[REDACTED:openai_key]')
  })

  it('get_memories lists active facts in the project scope', async () => {
    const add = tools.get('add_memory') as ToolDefinition
    await add.execute({ text: 'Widgets use pnpm as the package manager.' }, toolCtx)
    await add.execute({ text: 'Widgets target Node 24.' }, toolCtx)

    const list = tools.get('get_memories') as ToolDefinition<{
      facts: { status: string }[]
      count: number
      scope: string
    }>
    const result = await list.execute({}, toolCtx)
    expect(result.scope).toBe('project:acme/widgets')
    expect(result.count).toBe(2)
    expect(result.facts.every((f) => f.status === 'active')).toBe(true)
  })

  it('get_memory returns found:false for an unknown id', async () => {
    const get = tools.get('get_memory') as ToolDefinition<{ found: boolean; id?: string }>
    const got = await get.execute({ id: 'fact_does_not_exist' }, toolCtx)
    expect(got.found).toBe(false)
    expect(got.id).toBe('fact_does_not_exist')
  })

  it('forget_memory deletes a fact by id and removes it from search', async () => {
    const add = tools.get('add_memory') as ToolDefinition<{ fact: { id: string } }>
    const added = await add.execute({ text: 'Widgets deploy via pnpm deploy widgets.' }, toolCtx)

    const forget = tools.get('forget_memory') as ToolDefinition<{ deleted: number }>
    const result = await forget.execute({ factId: added.fact.id }, toolCtx)
    expect(result.deleted).toBeGreaterThan(0)

    const get = tools.get('get_memory') as ToolDefinition<{ found: boolean }>
    expect((await get.execute({ id: added.fact.id }, toolCtx)).found).toBe(false)
  })

  it('forget_memory rejects an empty selector', async () => {
    const forget = tools.get('forget_memory') as ToolDefinition
    await expect(forget.execute({}, toolCtx)).rejects.toThrow(/at least one selector/i)
  })

  it('forget_memory rejects a bulk SCOPE delete without confirm (CLI --yes parity, §18.2)', async () => {
    const add = tools.get('add_memory') as ToolDefinition
    await add.execute({ text: 'Widgets deploy via pnpm deploy widgets.' }, toolCtx)

    const forget = tools.get('forget_memory') as ToolDefinition<{ deleted: number }>
    // A scope selector is a destructive bulk delete -> must be gated.
    await expect(
      forget.execute({ scope: { type: 'project', key: 'acme/widgets' } }, toolCtx),
    ).rejects.toThrow(/bulk delete requires confirm/i)

    // The fact is still present (nothing was deleted).
    const get = tools.get('get_memories') as ToolDefinition<{ count: number }>
    expect((await get.execute({}, toolCtx)).count).toBeGreaterThan(0)
  })

  it('forget_memory rejects a date-range bulk delete without confirm', async () => {
    const forget = tools.get('forget_memory') as ToolDefinition
    await expect(forget.execute({ before: '2030-01-01T00:00:00.000Z' }, toolCtx)).rejects.toThrow(
      /bulk delete requires confirm/i,
    )
  })

  it('forget_memory performs a bulk scope delete WHEN confirm:true is passed', async () => {
    const add = tools.get('add_memory') as ToolDefinition
    await add.execute({ text: 'Widgets deploy via pnpm deploy widgets.' }, toolCtx)
    await add.execute({ text: 'Widgets use pnpm as the package manager.' }, toolCtx)

    const forget = tools.get('forget_memory') as ToolDefinition<{ deleted: number }>
    const result = await forget.execute(
      { scope: { type: 'project', key: 'acme/widgets' }, confirm: true },
      toolCtx,
    )
    expect(result.deleted).toBeGreaterThan(0)
    const get = tools.get('get_memories') as ToolDefinition<{ count: number }>
    expect((await get.execute({}, toolCtx)).count).toBe(0)
  })

  it('forget_memory does NOT require confirm for a single-id delete', async () => {
    const add = tools.get('add_memory') as ToolDefinition<{ fact: { id: string } }>
    const added = await add.execute({ text: 'Widgets deploy via pnpm.' }, toolCtx)
    const forget = tools.get('forget_memory') as ToolDefinition<{ deleted: number }>
    // No confirm needed: a bare factId is a targeted (non-bulk) delete.
    const result = await forget.execute({ factId: added.fact.id }, toolCtx)
    expect(result.deleted).toBeGreaterThan(0)
  })

  it('build_memory_context returns a token-bounded prompt block', async () => {
    const add = tools.get('add_memory') as ToolDefinition
    await add.execute({ text: 'The deploy command for widgets is pnpm deploy widgets.' }, toolCtx)

    const buildContext = tools.get('build_memory_context') as ToolDefinition<{
      items: unknown[]
      promptBlock: string
      tokenEstimate: number
    }>
    const result = await buildContext.execute(
      { query: 'how do I deploy widgets', tokenBudget: 256 },
      toolCtx,
    )
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.tokenEstimate).toBeLessThanOrEqual(256)
    expect(result.promptBlock.length).toBeGreaterThan(0)
  })

  it('list_entities lists entities linked in the project scope', async () => {
    const add = tools.get('add_memory') as ToolDefinition
    // Provide an explicit subject so an entity is linked deterministically.
    await add.execute(
      { text: 'Widgets uses Vitest for testing.', subject: 'Widgets', object: 'Vitest' },
      toolCtx,
    )

    const listEntities = tools.get('list_entities') as ToolDefinition<{
      entities: { canonicalName: string }[]
      count: number
      scope: string
    }>
    const result = await listEntities.execute({}, toolCtx)
    expect(result.scope).toBe('project:acme/widgets')
    expect(result.count).toBeGreaterThan(0)
  })

  it('memory_status reports the embedded transport and DB counts', async () => {
    const add = tools.get('add_memory') as ToolDefinition
    await add.execute({ text: 'Widgets use pnpm.' }, toolCtx)

    const status = tools.get('memory_status') as ToolDefinition<{
      server: { mode: string }
      counts: { facts: number }
      retentionMode: string
    }>
    const result = await status.execute({}, toolCtx)
    expect(result.server.mode).toBe('embedded')
    expect(result.counts.facts).toBeGreaterThan(0)
    expect(result.retentionMode).toBe('redacted')
  })

  it('rejects an invalid add_memory arg (zod validation)', async () => {
    const add = tools.get('add_memory') as ToolDefinition
    await expect(add.execute({ text: '' }, toolCtx)).rejects.toThrow()
    await expect(add.execute({}, toolCtx)).rejects.toThrow()
  })

  it("global search is bounded to the resolved user: another user's user-scope facts do not leak (§9.1)", async () => {
    // The resolved user is the OS username (the adapter threads it as globalUser).
    const resolved = resolveScopes({ cwd: '/work/widgets' }, fixedGit)
    const me = resolved.user.key

    // Seed: MY user fact, ANOTHER user's fact, and a project fact (shared DB).
    await naru.ensureScope('user', me)
    await naru.ensureScope('user', 'someone-else')
    await naru.addMemory({
      text: 'My personal editor is neovim.',
      scope: { type: 'user', key: me },
    })
    await naru.addMemory({
      text: "Other user's private secret preference is emacs.",
      scope: { type: 'user', key: 'someone-else' },
    })
    await naru.addMemory({
      text: 'Widgets deploy via pnpm deploy widgets.',
      scope: { type: 'project', key: 'acme/widgets' },
    })

    const search = tools.get('search_memories') as ToolDefinition<{
      results: { scope: string; statement: string }[]
    }>
    const res = await search.execute({ query: 'editor preference', global: true }, toolCtx)
    const scopes = res.results.map((r) => r.scope)
    // The other user's user-scope fact is NOT surfaced (user half is bounded).
    expect(scopes).not.toContain('user:someone-else')
    // My own user-scope fact is reachable under a global read.
    expect(res.results.some((r) => r.statement.includes('neovim'))).toBe(true)
  })
})

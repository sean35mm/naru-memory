import { Naru } from '@naru/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AdapterClient, EmbeddedAdapterClient } from './client'
import { type MemorySink, type SurfacedMemory, createHooks, detectMemoryIntent } from './hooks'
import type { GitRunner } from './scope'
import { resolveScopes } from './scope'
import type { ChatMessage, Hooks, MessagesTransformHookInput, PluginContext } from './types'

/**
 * Hooks-against-embedded-Naru integration (plan §17.4, §21.5).
 *
 * Drives the six §17.4 hooks through an {@link EmbeddedAdapterClient} over a
 * real `:memory:` Naru — no OpenCode runtime, no server, no network. A fixed
 * {@link GitRunner} pins the resolved scopes so writes land in (and reads honor)
 * a deterministic `project` scope. A recording {@link MemorySink} captures what
 * each hook surfaces so behavior is asserted without a real runtime.
 */

/** Fixed git runner: every session resolves to project `acme/widgets` on `main`. */
const fixedGit: GitRunner = {
  remoteUrl: () => 'git@github.com:acme/widgets.git',
  topLevel: () => '/work/widgets',
  currentBranch: () => 'main',
}

const cwd = '/work/widgets'
const sessionId = 'sess-1'
const agentId = 'claude'

/** The full rendered opening marker shape a real injected system block carries. */
const MARKER_RE = /^<naru-memory turn="[^"]*">/m

/** A recording sink: collects every surfaced event for assertions. */
function recordingSink(): MemorySink & {
  recalls: { query: string; items: SurfacedMemory[] }[]
  toolErrors: { tool: string; error: string; items: SurfacedMemory[] }[]
  compactions: { items: SurfacedMemory[] }[]
} {
  const recalls: { query: string; items: SurfacedMemory[] }[] = []
  const toolErrors: { tool: string; error: string; items: SurfacedMemory[] }[] = []
  const compactions: { items: SurfacedMemory[] }[] = []
  return {
    recalls,
    toolErrors,
    compactions,
    recall(e) {
      recalls.push(e)
    },
    toolError(e) {
      toolErrors.push(e)
    },
    compaction(e) {
      compactions.push(e)
    },
  }
}

describe('detectMemoryIntent (pure intent detection, §17.4)', () => {
  it('detects a remember-that intent and extracts the payload', () => {
    expect(detectMemoryIntent('Remember that we use pnpm for widgets.')).toEqual({
      kind: 'remember',
      query: 'we use pnpm for widgets.',
    })
  })

  it('detects a remember-to intent', () => {
    expect(detectMemoryIntent('remember to run the migration before deploy')).toEqual({
      kind: 'remember',
      query: 'run the migration before deploy',
    })
  })

  it('detects a "what did we decide about" recall and strips trailing punctuation', () => {
    expect(detectMemoryIntent('What did we decide about the database?')).toEqual({
      kind: 'recall',
      query: 'the database',
    })
  })

  it('detects a bare resume verb as a recall over the whole message', () => {
    const intent = detectMemoryIntent('resume')
    expect(intent?.kind).toBe('recall')
    expect(intent?.query).toBe('resume')
  })

  it('returns null for ordinary chatter', () => {
    expect(detectMemoryIntent('can you write a function that adds two numbers')).toBeNull()
    expect(detectMemoryIntent('')).toBeNull()
    expect(detectMemoryIntent('   ')).toBeNull()
  })
})

describe('hooks against an embedded :memory: Naru (plan §17.4)', () => {
  let naru: Naru
  let client: AdapterClient
  let sink: ReturnType<typeof recordingSink>
  let hooks: Hooks

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
    client = new EmbeddedAdapterClient(naru)
    sink = recordingSink()
    const ctx: PluginContext = {
      client,
      resolveScopes: (input) => resolveScopes(input, fixedGit),
    }
    hooks = createHooks(ctx, { sink })
  })

  afterEach(async () => {
    await client.close()
  })

  // --- config -----------------------------------------------------------
  it('config registers exactly the eight native tools and enables NO MCP (§17.2/§17.6)', () => {
    const config: Record<string, unknown> = {}
    hooks.config?.({ config })

    const tools = config.tools as { name: string }[]
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.map((t) => t.name).sort()).toEqual(
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
    // The config hook must never enable MCP.
    expect(config).not.toHaveProperty('mcp')
    expect(JSON.stringify(config).toLowerCase()).not.toContain('mcp')
  })

  it('config preserves tools the runtime already registered (§17.6)', () => {
    const config: Record<string, unknown> = { tools: [{ name: 'preexisting' }] }
    hooks.config?.({ config })
    const tools = config.tools as { name: string }[]
    expect(tools[0]?.name).toBe('preexisting')
    expect(tools).toHaveLength(9)
  })

  // --- chat.message -----------------------------------------------------
  it('chat.message recall triggers a scoped search and surfaces redacted hits', async () => {
    // Seed a fact in the resolved project scope.
    await naru.addMemory({
      text: 'The deploy command for widgets is pnpm deploy widgets.',
      scope: { type: 'project', key: 'acme/widgets' },
    })

    await hooks['chat.message']?.({
      message: { role: 'user', content: 'What did we decide about the deploy command?' },
      cwd,
      sessionId,
      agentId,
    })

    expect(sink.recalls).toHaveLength(1)
    const recall = sink.recalls[0]
    expect(recall?.query).toBe('the deploy command')
    expect(recall?.items.length).toBeGreaterThan(0)
    // Scope-safe: surfaced hits are confined to the resolved scope set (§9.4).
    expect(recall?.items.every((i) => i.scope === 'project:acme/widgets')).toBe(true)
    expect(recall?.items.some((i) => i.statement.includes('pnpm deploy widgets'))).toBe(true)
  })

  it('chat.message remember captures a fact (redacted by core, §18.1)', async () => {
    const secret = 'sk-abcDEF0123456789abcdef0123'
    await hooks['chat.message']?.({
      message: { role: 'user', content: `Remember that the OpenAI key is ${secret} for widgets.` },
      cwd,
      sessionId,
      agentId,
    })

    // The capture lands in the project scope; the stored fact is redacted.
    const facts = await client.list({ scope: { type: 'project', key: 'acme/widgets' } })
    expect(facts.length).toBeGreaterThan(0)
    const joined = facts.map((f) => f.statement).join('\n')
    expect(joined).not.toContain(secret)
    expect(joined).toContain('[REDACTED:openai_key]')
    // No recall is surfaced for a remember intent.
    expect(sink.recalls).toHaveLength(0)
  })

  it('chat.message ignores ordinary (non-intent) and non-user messages', async () => {
    await hooks['chat.message']?.({
      message: { role: 'user', content: 'please refactor this function' },
      cwd,
      sessionId,
    })
    await hooks['chat.message']?.({
      message: { role: 'assistant', content: 'remember that this should be ignored' },
      cwd,
      sessionId,
    })
    expect(sink.recalls).toHaveLength(0)
    const facts = await client.list({ scope: { type: 'project', key: 'acme/widgets' } })
    expect(facts).toHaveLength(0)
  })

  // --- experimental.chat.messages.transform -----------------------------
  it('transform injects a memory-context block exactly ONCE per turn', async () => {
    await naru.addMemory({
      text: 'The deploy command for widgets is pnpm deploy widgets.',
      scope: { type: 'project', key: 'acme/widgets' },
    })

    const transform = hooks['experimental.chat.messages.transform']
    expect(transform).toBeDefined()
    const baseMessages: ChatMessage[] = [{ role: 'user', content: 'how do I deploy widgets' }]
    const input: MessagesTransformHookInput = { messages: baseMessages, cwd, sessionId, agentId }

    // First call: injects a system block with the memory context.
    const first = (await transform?.(input)) as ChatMessage[]
    expect(first.length).toBe(baseMessages.length + 1)
    expect(first[0]?.role).toBe('system')
    expect(first[0]?.content).toContain('<naru-memory')
    expect(first[0]?.content).toContain('pnpm deploy widgets')

    // Second call on the SAME turn (messages already carry the marker): no
    // double-injection — the marker is detected and the list returns unchanged.
    const second = (await transform?.({ ...input, messages: first })) as ChatMessage[]
    const blocks = second.filter((m) => m.content.includes('<naru-memory')).length
    expect(blocks).toBe(1)

    // Even a fresh copy (marker stripped) on the same turn does not re-inject,
    // thanks to the per-turn guard.
    const third = (await transform?.(input)) as ChatMessage[]
    expect(third.length).toBe(baseMessages.length)
    expect(third.some((m) => m.content.includes('<naru-memory'))).toBe(false)
  })

  it('transform injects fresh context on the NEXT turn (new user message)', async () => {
    await naru.addMemory({
      text: 'Widgets use pnpm as the package manager.',
      scope: { type: 'project', key: 'acme/widgets' },
    })
    const transform = hooks['experimental.chat.messages.transform']

    const turn1: ChatMessage[] = [{ role: 'user', content: 'what package manager' }]
    const out1 = (await transform?.({ messages: turn1, cwd, sessionId })) as ChatMessage[]
    expect(out1[0]?.content).toContain('<naru-memory')

    // Next turn: one more user message -> a new turn key -> injects again.
    const turn2: ChatMessage[] = [
      { role: 'user', content: 'what package manager' },
      { role: 'assistant', content: 'pnpm' },
      { role: 'user', content: 'remind me again about the package manager' },
    ]
    const out2 = (await transform?.({ messages: turn2, cwd, sessionId })) as ChatMessage[]
    expect(out2[0]?.role).toBe('system')
    expect(out2[0]?.content).toContain('<naru-memory')
  })

  it('transform injects nothing when no relevant memory exists', async () => {
    const transform = hooks['experimental.chat.messages.transform']
    const messages: ChatMessage[] = [{ role: 'user', content: 'how do I deploy widgets' }]
    const out = (await transform?.({ messages, cwd, sessionId })) as ChatMessage[]
    expect(out).toHaveLength(1)
    expect(out.some((m) => m.content.includes('<naru-memory'))).toBe(false)
  })

  // --- tool.execute.after -----------------------------------------------
  it('tool.execute.after on a failure surfaces a prior gotcha; success is a no-op', async () => {
    await naru.addMemory({
      text: 'When pnpm install fails with ERR_PNPM_FROZEN_LOCKFILE, run pnpm install --no-frozen-lockfile.',
      scope: { type: 'project', key: 'acme/widgets' },
    })

    // Success -> no surfacing.
    await hooks['tool.execute.after']?.({ tool: 'bash', error: null, cwd, sessionId })
    expect(sink.toolErrors).toHaveLength(0)

    // Failure -> a scoped search of prior gotchas is surfaced.
    await hooks['tool.execute.after']?.({
      tool: 'pnpm',
      error: { message: 'ERR_PNPM_FROZEN_LOCKFILE install failed' },
      cwd,
      sessionId,
    })
    expect(sink.toolErrors).toHaveLength(1)
    const evt = sink.toolErrors[0]
    expect(evt?.tool).toBe('pnpm')
    expect(evt?.items.length).toBeGreaterThan(0)
    expect(evt?.items.some((i) => i.statement.includes('--no-frozen-lockfile'))).toBe(true)
  })

  // --- experimental.session.compacting ----------------------------------
  it('compacting captures a summary marker into the TRANSIENT session scope (not project) AND re-surfaces prior salient context', async () => {
    await naru.addMemory({
      text: 'The deploy command for widgets is pnpm deploy widgets.',
      scope: { type: 'project', key: 'acme/widgets' },
    })
    const projectBefore = (await client.list({ scope: { type: 'project', key: 'acme/widgets' } }))
      .length
    const sessionBefore = (await client.list({ scope: { type: 'session', key: sessionId } })).length

    await hooks['experimental.session.compacting']?.({
      summary: 'We configured the deploy command and chose pnpm for widgets.',
      cwd,
      sessionId,
      agentId,
    })

    // (1) The compaction summary (transient run-local state, §9.2) is captured
    // into the SESSION scope — NOT the durable project scope, so it does not
    // later surface to unrelated future sessions in the same repo. (Capture is
    // fire-and-forget per §13.2; the embedded client's better-sqlite3 write is
    // synchronous so the row is present by the time we list.)
    const sessionAfter = (await client.list({ scope: { type: 'session', key: sessionId } })).length
    expect(sessionAfter).toBeGreaterThan(sessionBefore)
    // The durable project scope is unchanged (no session-state bleed).
    const projectAfter = (await client.list({ scope: { type: 'project', key: 'acme/widgets' } }))
      .length
    expect(projectAfter).toBe(projectBefore)

    // (2) Prior salient context is re-surfaced for re-injection (reads honor the
    // full resolved scope set, so the seeded project fact still surfaces).
    expect(sink.compactions).toHaveLength(1)
    expect(sink.compactions[0]?.items.length).toBeGreaterThan(0)
  })

  it('compacting falls back to branch (then project) when there is no session', async () => {
    // No sessionId -> session scope is null; transient write routes to branch.
    const branchBefore = (await client.list({ scope: { type: 'branch', key: 'main' } })).length
    await hooks['experimental.session.compacting']?.({
      summary: 'Branch-local note about the widgets build.',
      cwd,
    })
    const branchAfter = (await client.list({ scope: { type: 'branch', key: 'main' } })).length
    expect(branchAfter).toBeGreaterThan(branchBefore)
  })

  // --- shell.env --------------------------------------------------------
  it('shell.env exports Naru scope/session env vars and preserves existing env', async () => {
    const out = (await hooks['shell.env']?.({
      env: { PATH: '/usr/bin', NARU_DB: 'preset-db' },
      cwd,
      sessionId,
      agentId,
    })) as Record<string, string>

    // Existing env is preserved; a preset NARU_DB is NOT clobbered (§17.6).
    expect(out.PATH).toBe('/usr/bin')
    expect(out.NARU_DB).toBe('preset-db')
    // Scope vars are exported from the resolved scope set.
    expect(out.NARU_SCOPE_USER?.length).toBeGreaterThan(0)
    expect(out.NARU_SCOPE_WORKSPACE).toBe(cwd)
    expect(out.NARU_SCOPE_PROJECT).toBe('acme/widgets')
    expect(out.NARU_SCOPE_BRANCH).toBe('main')
    expect(out.NARU_SCOPE_SESSION).toBe(sessionId)
    expect(out.NARU_SCOPE_AGENT).toBe(agentId)
  })

  it('shell.env fills NARU_DB from status when unset', async () => {
    const out = (await hooks['shell.env']?.({ env: {}, cwd, sessionId })) as Record<string, string>
    // Embedded :memory: Naru reports its db path; the var is populated.
    expect(typeof out.NARU_DB).toBe('string')
    expect((out.NARU_DB ?? '').length).toBeGreaterThan(0)
  })

  // --- double-injection guard robustness (§17.4) ------------------------
  it('transform is NOT suppressed by an incidental "<naru-memory" substring in user/fact content', async () => {
    // A fact whose statement legitimately contains the marker substring (core
    // stores it verbatim; it is not a secret, so redaction keeps it).
    await naru.addMemory({
      text: 'The injection marker syntax is <naru-memory turn="..."> for widgets.',
      scope: { type: 'project', key: 'acme/widgets' },
    })
    const transform = hooks['experimental.chat.messages.transform']
    // User content ALSO contains the bare substring — must not trip the guard.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'what is the <naru-memory marker for widgets' },
    ]
    const out = (await transform?.({ messages, cwd, sessionId })) as ChatMessage[]
    // The guard is anchored to a system-role full marker, so injection still
    // happens: a real <naru-memory turn="..."> system block is prepended.
    expect(out[0]?.role).toBe('system')
    expect(MARKER_RE.test(out[0]?.content ?? '')).toBe(true)
  })
})

// --- hook error containment: hooks never throw into the host loop (§17.1) ---
describe('hooks degrade gracefully on a failing client (never throw, §17.1)', () => {
  /** A client whose every method rejects (mirrors a remote server hiccup). */
  const failingClient: AdapterClient = {
    ensureScope: () => Promise.reject(new Error('boom')),
    addMemory: () => Promise.reject(new Error('boom')),
    captureExtract: () => Promise.reject(new Error('boom')),
    search: () => Promise.reject(new Error('boom')),
    buildContext: () => Promise.reject(new Error('boom')),
    list: () => Promise.reject(new Error('boom')),
    get: () => Promise.reject(new Error('boom')),
    listEntities: () => Promise.reject(new Error('boom')),
    forget: () => Promise.reject(new Error('boom')),
    status: () => Promise.reject(new Error('boom')),
    close: () => Promise.resolve(),
  }
  const ctx: PluginContext = {
    client: failingClient,
    resolveScopes: (i) => resolveScopes(i, fixedGit),
  }
  const hooks = createHooks(ctx)

  it('chat.message (recall) resolves without throwing', async () => {
    await expect(
      hooks['chat.message']?.({
        message: { role: 'user', content: 'recall the deploy command' },
        cwd,
        sessionId,
      }),
    ).resolves.toBeUndefined()
  })

  it('chat.message (remember) resolves without throwing', async () => {
    await expect(
      hooks['chat.message']?.({
        message: { role: 'user', content: 'remember that widgets use pnpm' },
        cwd,
        sessionId,
      }),
    ).resolves.toBeUndefined()
  })

  it('transform returns the ORIGINAL messages unchanged on a client failure', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'how do I deploy widgets' }]
    const out = await hooks['experimental.chat.messages.transform']?.({ messages, cwd, sessionId })
    expect(out).toEqual(messages)
  })

  it('tool.execute.after resolves without throwing on a client failure', async () => {
    await expect(
      hooks['tool.execute.after']?.({ tool: 'pnpm', error: { message: 'fail' }, cwd, sessionId }),
    ).resolves.toBeUndefined()
  })

  it('session.compacting resolves without throwing on a client failure', async () => {
    await expect(
      hooks['experimental.session.compacting']?.({ summary: 'a summary', cwd, sessionId }),
    ).resolves.toBeUndefined()
  })

  it('shell.env returns the env UNMODIFIED on a client failure', async () => {
    const env = { PATH: '/usr/bin' }
    const out = await hooks['shell.env']?.({ env, cwd, sessionId })
    expect(out).toEqual(env)
  })
})

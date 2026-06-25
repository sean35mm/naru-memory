import type { Hooks } from '@opencode-ai/plugin'
import { describe, expect, it, vi } from 'vitest'
import { buildNaruHooks, detectMemoryIntent } from './opencode-plugin'
import { NoServerError } from './remote'
import type { RemoteClient } from './remote'
import type { ResolvedScopes } from './scope'

/**
 * Unit tests for the REAL OpenCode plugin (`@opencode-ai/plugin`).
 *
 * The hooks are built with an INJECTED fake {@link RemoteClient} + a deterministic
 * scope resolver — NO real network, NO opencode runtime. We assert: the 8 tools
 * exist and each executes (returns a string-bearing result) against the fake; the
 * transform hook mutates `output.messages` exactly once; a no-server condition
 * yields friendly tool messages; and no hook throws into the host loop.
 */

/** A deterministic resolved scope set (no git, no child_process). */
const RESOLVED: ResolvedScopes = {
  user: { type: 'user', key: 'alice' },
  workspace: { type: 'workspace', key: '/work/widgets' },
  project: { type: 'project', key: 'acme/widgets' },
  branch: { type: 'branch', key: 'main' },
  session: null,
  agent: null,
}

/** Build a fully-stubbed {@link RemoteClient} whose methods are vi mocks. */
function fakeClient(overrides: Partial<RemoteClient> = {}): RemoteClient {
  const base: RemoteClient = {
    search: vi.fn().mockResolvedValue([
      {
        factId: 'f1',
        statement: 'use pnpm not npm',
        scope: 'project:acme/widgets',
        score: 0.9,
        reasons: [],
        temporal: { validFrom: null, validTo: null },
        evidenceRefs: [],
      },
    ]),
    addMemory: vi
      .fn()
      .mockResolvedValue({ id: 'f1', statement: 'remembered', scope: 'project:acme/widgets' }),
    get: vi
      .fn()
      .mockResolvedValue({ fact: { id: 'f1', statement: 'a fact' }, evidence: [{ id: 'e1' }] }),
    list: vi.fn().mockResolvedValue([{ id: 'f1', statement: 'fact one' }]),
    forget: vi.fn().mockResolvedValue({ deleted: 1 }),
    buildContext: vi.fn().mockResolvedValue({
      items: [{ statement: 'use pnpm', scope: 'project:acme/widgets', score: 0.9 }],
      promptBlock: 'Relevant memory:\n- use pnpm',
      tokenEstimate: 12,
    }),
    listEntities: vi.fn().mockResolvedValue([{ type: 'tool', canonicalName: 'pnpm' }]),
    status: vi.fn().mockResolvedValue({
      dbPath: '/db/naru.db',
      counts: { facts: 3, entities: 1, episodes: 2, scopes: 4 },
      retentionMode: 'standard',
      features: { extractor: { available: false }, vector: { embedder: { available: false } } },
    }),
    capture: vi.fn().mockResolvedValue({ episode: { id: 'ep1' }, facts: [] }),
    ensureScope: vi.fn().mockResolvedValue({ id: 's1', type: 'project', key: 'acme/widgets' }),
    resolveServer: vi
      .fn()
      .mockReturnValue({ baseUrl: 'http://127.0.0.1:4319', token: 't', source: 'discovery' }),
  } as unknown as RemoteClient
  return { ...base, ...overrides }
}

/** A fake client whose every async method rejects with a NoServerError. */
function noServerClient(): RemoteClient {
  const reject = vi.fn().mockRejectedValue(new NoServerError())
  return {
    search: reject,
    addMemory: reject,
    get: reject,
    list: reject,
    forget: reject,
    buildContext: reject,
    listEntities: reject,
    status: reject,
    capture: reject,
    ensureScope: reject,
    resolveServer: vi.fn(() => {
      throw new NoServerError()
    }),
  } as unknown as RemoteClient
}

/** Build the hooks with the fake client + deterministic scope resolver. */
function hooksWith(client: RemoteClient): Hooks {
  return buildNaruHooks({
    client,
    directory: '/work/widgets',
    resolveScopes: () => RESOLVED,
  })
}

/** A minimal ToolContext stub (only what `execute` may read; ours reads none). */
const TOOL_CTX = {
  sessionID: 's',
  messageID: 'm',
  agent: 'a',
  directory: '/work/widgets',
  worktree: '/work/widgets',
  abort: new AbortController().signal,
  metadata: () => {},
  ask: () => undefined,
} as never

/** Extract the string output from a ToolResult (string | { output }). */
function outputOf(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }
  const out = (result as { output?: unknown }).output
  return typeof out === 'string' ? out : ''
}

const TOOL_NAMES = [
  'add_memory',
  'search_memories',
  'get_memories',
  'get_memory',
  'forget_memory',
  'build_memory_context',
  'list_entities',
  'memory_status',
] as const

describe('NaruMemory plugin — tools (real @opencode-ai/plugin)', () => {
  it('registers exactly the 8 native tools', () => {
    const hooks = hooksWith(fakeClient())
    expect(hooks.tool).toBeDefined()
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...TOOL_NAMES].sort())
  })

  it('each tool executes and returns a non-empty string output against the fake', async () => {
    const hooks = hooksWith(fakeClient())
    const tools = hooks.tool ?? {}

    const args: Record<string, unknown> = {
      add_memory: { text: 'remember pnpm' },
      search_memories: { query: 'package manager' },
      get_memories: {},
      get_memory: { id: 'f1' },
      forget_memory: { factId: 'f1' },
      build_memory_context: { query: 'how do we build' },
      list_entities: {},
      memory_status: {},
    }

    for (const name of TOOL_NAMES) {
      const def = tools[name]
      expect(def, `tool ${name} present`).toBeDefined()
      const result = await def?.execute(args[name] as never, TOOL_CTX)
      expect(outputOf(result).length, `tool ${name} returns output`).toBeGreaterThan(0)
    }
  })

  it('add_memory writes to the project scope by default', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    await hooks.tool?.add_memory?.execute({ text: 'x' } as never, TOOL_CTX)
    expect(client.addMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { type: 'project', key: 'acme/widgets' } }),
    )
  })

  it('add_memory honors an explicit scope arg', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    await hooks.tool?.add_memory?.execute(
      { text: 'x', scope: { type: 'user', key: 'alice' } } as never,
      TOOL_CTX,
    )
    expect(client.addMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { type: 'user', key: 'alice' } }),
    )
  })

  it('forget_memory refuses a bulk delete without confirm and does not call the client', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    const result = await hooks.tool?.forget_memory?.execute(
      { scope: { type: 'project', key: 'acme/widgets' } } as never,
      TOOL_CTX,
    )
    expect(outputOf(result)).toMatch(/confirm: true/)
    expect(client.forget).not.toHaveBeenCalled()
  })

  it('forget_memory allows a single-id delete without confirm', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    await hooks.tool?.forget_memory?.execute({ factId: 'f1' } as never, TOOL_CTX)
    expect(client.forget).toHaveBeenCalledWith(expect.objectContaining({ factId: 'f1' }))
  })

  it('every tool returns the friendly no-server message instead of throwing', async () => {
    const hooks = hooksWith(noServerClient())
    const tools = hooks.tool ?? {}
    const args: Record<string, unknown> = {
      add_memory: { text: 'x' },
      search_memories: { query: 'q' },
      get_memories: {},
      get_memory: { id: 'f1' },
      forget_memory: { factId: 'f1' },
      build_memory_context: { query: 'q' },
      list_entities: {},
      memory_status: {},
    }
    for (const name of TOOL_NAMES) {
      const result = await tools[name]?.execute(args[name] as never, TOOL_CTX)
      expect(outputOf(result), `tool ${name} friendly no-server message`).toMatch(/naru serve/)
    }
  })
})

describe('NaruMemory plugin — hooks (real @opencode-ai/plugin)', () => {
  /** Build a transform `output` with a single user message bearing text parts. */
  function transformOutput(text: string) {
    return {
      messages: [
        {
          info: {
            id: 'm1',
            sessionID: 's1',
            role: 'user' as const,
            time: { created: 1 },
            agent: 'a',
            model: { providerID: 'p', modelID: 'm' },
          },
          parts: [{ id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text' as const, text }],
        },
      ],
    }
  }

  it('transform mutates output.messages once (prepends a memory block)', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    const output = transformOutput('how do we build the project') as never
    await hooks['experimental.chat.messages.transform']?.({}, output)
    const out = output as ReturnType<typeof transformOutput>
    expect(out.messages.length).toBe(2)
    const injected = out.messages[0]?.parts[0]
    expect(injected?.type).toBe('text')
    expect(injected?.text).toContain('<naru-memory>')
    expect(injected?.text).toContain('use pnpm')
  })

  it('transform does not double-inject on a second call over the same output', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    const output = transformOutput('how do we build') as never
    await hooks['experimental.chat.messages.transform']?.({}, output)
    await hooks['experimental.chat.messages.transform']?.({}, output)
    const out = output as ReturnType<typeof transformOutput>
    // One injected block only (2 = original + 1 injected, not 3).
    expect(out.messages.length).toBe(2)
  })

  it('transform injects nothing when buildContext returns no items', async () => {
    const client = fakeClient({
      buildContext: vi.fn().mockResolvedValue({ items: [], promptBlock: '', tokenEstimate: 0 }),
    })
    const hooks = hooksWith(client)
    const output = transformOutput('anything') as never
    await hooks['experimental.chat.messages.transform']?.({}, output)
    const out = output as ReturnType<typeof transformOutput>
    expect(out.messages.length).toBe(1)
  })

  it('transform does not throw on a no-server condition (messages untouched)', async () => {
    const hooks = hooksWith(noServerClient())
    const output = transformOutput('anything') as never
    await expect(
      hooks['experimental.chat.messages.transform']?.({}, output),
    ).resolves.toBeUndefined()
    const out = output as ReturnType<typeof transformOutput>
    expect(out.messages.length).toBe(1)
  })

  it('chat.message fires a capture for an explicit remember intent (fire-and-forget)', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    await hooks['chat.message']?.({ sessionID: 's1' } as never, {
      message: { role: 'user' } as never,
      parts: [{ type: 'text', text: 'remember that we use pnpm' }] as never,
    })
    // Fire-and-forget: allow the microtask chain to settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(client.capture).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'we use pnpm', sourceType: 'manual' }),
    )
  })

  it('chat.message ignores a message with no memory intent', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    await hooks['chat.message']?.({ sessionID: 's1' } as never, {
      message: { role: 'user' } as never,
      parts: [{ type: 'text', text: 'hello there' }] as never,
    })
    await Promise.resolve()
    expect(client.capture).not.toHaveBeenCalled()
  })

  it('tool.execute.after appends a memory hint on an error-looking output', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    const output = { title: 'bash', output: 'Error: command failed', metadata: {} } as never
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 's1', callID: 'c1', args: {} },
      output,
    )
    const meta = (output as { metadata: Record<string, unknown> }).metadata
    expect(meta.naruMemoryHint).toBeDefined()
    expect(String(meta.naruMemoryHint)).toContain('use pnpm')
  })

  it('tool.execute.after is a no-op on a successful (non-error) output', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    const output = { title: 'bash', output: 'ok done', metadata: {} } as never
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 's1', callID: 'c1', args: {} },
      output,
    )
    expect(client.search).not.toHaveBeenCalled()
    expect(
      (output as { metadata: Record<string, unknown> }).metadata.naruMemoryHint,
    ).toBeUndefined()
  })

  it('tool.execute.after does not throw on a no-server condition', async () => {
    const hooks = hooksWith(noServerClient())
    const output = { title: 't', output: 'Error: boom', metadata: {} } as never
    await expect(
      hooks['tool.execute.after']?.({ tool: 'x', sessionID: 's', callID: 'c', args: {} }, output),
    ).resolves.toBeUndefined()
  })

  it('experimental.session.compacting pushes salient context strings', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    const output = { context: [] as string[] } as never
    await hooks['experimental.session.compacting']?.({ sessionID: 's1' }, output)
    const out = output as { context: string[] }
    expect(out.context.length).toBeGreaterThan(0)
    expect(out.context[0]).toContain('use pnpm')
  })

  it('experimental.session.compacting does not throw on a no-server condition', async () => {
    const hooks = hooksWith(noServerClient())
    const output = { context: [] as string[] } as never
    await expect(
      hooks['experimental.session.compacting']?.({ sessionID: 's1' }, output),
    ).resolves.toBeUndefined()
    expect((output as { context: string[] }).context.length).toBe(0)
  })

  it('shell.env sets NARU scope vars without clobbering existing values', async () => {
    const client = fakeClient()
    const hooks = hooksWith(client)
    const output = { env: { NARU_SCOPE_USER: 'preset' } as Record<string, string> } as never
    await hooks['shell.env']?.({ cwd: '/work/widgets' }, output)
    const env = (output as { env: Record<string, string> }).env
    expect(env.NARU_SCOPE_USER).toBe('preset') // not clobbered
    expect(env.NARU_SCOPE_PROJECT).toBe('acme/widgets')
    expect(env.NARU_SCOPE_BRANCH).toBe('main')
  })

  it('shell.env exports NARU_SERVER_URL when a server url is known', async () => {
    const hooks = buildNaruHooks({
      client: fakeClient(),
      directory: '/work/widgets',
      resolveScopes: () => RESOLVED,
      serverUrl: 'http://127.0.0.1:4319',
    })
    const output = { env: {} as Record<string, string> } as never
    await hooks['shell.env']?.({ cwd: '/work/widgets' }, output)
    expect((output as { env: Record<string, string> }).env.NARU_SERVER_URL).toBe(
      'http://127.0.0.1:4319',
    )
  })
})

describe('detectMemoryIntent (preserved behavior)', () => {
  it('classifies a remember intent', () => {
    expect(detectMemoryIntent('remember that we use pnpm')).toEqual({
      kind: 'remember',
      query: 'we use pnpm',
    })
  })

  it('classifies a recall intent', () => {
    expect(detectMemoryIntent('what did we decide about the database?')).toEqual({
      kind: 'recall',
      query: 'the database',
    })
  })

  it('returns null for arbitrary chatter', () => {
    expect(detectMemoryIntent('hello, how are you')).toBeNull()
  })
})

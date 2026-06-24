/**
 * OpenCode adapter hooks (plan §17.4).
 *
 * The hooks are the adapter's runtime behavior: they detect explicit memory
 * intents, inject relevant memory into prompts, surface prior fixes after tool
 * failures, preserve context across compaction, and export scope/session env
 * vars. Each hook is an INTEGRATION layer (§17.1/§17.2) — it owns NO memory
 * logic, NO extraction, NO direct DB writes, NO schema, and assumes NO MCP /
 * cloud. Everything routes through the injected {@link AdapterClient}: reads hit
 * only fast retrieval paths (search / buildContext / list), and any capture is
 * fire-and-forget so the agent loop is never blocked on a local LLM (§13.2).
 *
 * PURITY + TESTABILITY (per task brief): {@link createHooks} closes over the
 * injected {@link PluginContext} plus an optional {@link HookOptions} carrying a
 * {@link MemorySink} (where surfaced memory goes) and a per-turn injection
 * guard. With a mock sink + an embedded `:memory:` Naru the entire hook set is
 * unit-testable offline — no OpenCode runtime, no network. The real runtime
 * supplies the concrete hook payloads and consumes the returned values
 * (augmented `messages` from `transform`, the env map from `shell.env`); the
 * `MemorySink` is how the runtime shim presents recall/error/compaction context
 * back to the model (a thin documented seam — see {@link HookOptions}).
 *
 * REDACTION: write paths (the `remember` capture, the compaction marker) hand
 * raw text straight to core, which redacts before persistence (§18.1). Reads
 * return already-redacted facts; the injected text is built from those, so no
 * raw secret is ever injected.
 */

import type { ScopeSelector } from '@naru/core'
import type { AdapterClient } from './client'
import type { ResolvedScopes, ScopeRef } from './scope'
import { createTools } from './tools'
import type {
  ChatMessage,
  ChatMessageHookInput,
  ConfigHookInput,
  Hooks,
  MessagesTransformHookInput,
  PluginContext,
  SessionCompactingHookInput,
  ShellEnvHookInput,
  ToolDefinition,
  ToolExecuteAfterHookInput,
} from './types'

/**
 * A classified memory intent detected in a user message (plan §17.4
 * `chat.message`).
 *
 * - `remember`: an explicit "remember that ..." — capture the payload (core
 *   redacts and ingests; fire-and-forget).
 * - `recall`: an explicit "what did we decide about X" / "resume" / "what do
 *   you remember about X" — search the resolved scopes and surface results.
 * - `null`: no explicit memory intent (most messages).
 */
export interface MemoryIntent {
  kind: 'remember' | 'recall'
  /** The salient payload: the thing to remember, or the recall query. */
  query: string
}

/**
 * Where surfaced memory is delivered (plan §17.4). The hooks never print or
 * block; they hand structured findings to this sink and the runtime shim
 * decides how to present them (e.g. a system note appended to the next turn).
 * Tests inject a recording sink to assert what each hook surfaced. Defaults to
 * a no-op so the hooks are safe to run with no sink wired.
 */
export interface MemorySink {
  /** A recall (`chat.message`) result set for a detected query (§17.4). */
  recall(event: { query: string; items: SurfacedMemory[] }): void
  /** Prior fixes/gotchas found after a tool failure (§17.4 `tool.execute.after`). */
  toolError(event: { tool: string; error: string; items: SurfacedMemory[] }): void
  /** Salient context re-surfaced across a compaction (§17.4 compacting). */
  compaction(event: { items: SurfacedMemory[] }): void
}

/** A single surfaced memory line (a redacted fact + its scope/score). */
export interface SurfacedMemory {
  factId: string
  statement: string
  scope: string
  score: number
}

/**
 * Options threaded into {@link createHooks}. All optional with safe defaults so
 * the hooks run standalone; tests override them to observe behavior.
 */
export interface HookOptions {
  /** Where surfaced recall/error/compaction memory goes (default: no-op). */
  sink?: MemorySink
  /**
   * Max items a recall/error/compaction lookup surfaces (default 5). Keeps the
   * injected context bounded and the lookups on the fast retrieval path.
   */
  limit?: number
  /**
   * Token budget for the `transform` memory-context block (default 1024,
   * matching core's `context.build` default).
   */
  tokenBudget?: number
}

/** No-op sink: the default when the runtime/test wires none. */
const NOOP_SINK: MemorySink = {
  recall() {},
  toolError() {},
  compaction() {},
}

const DEFAULT_LIMIT = 5
const DEFAULT_TOKEN_BUDGET = 1024

/**
 * The HTML-ish marker wrapping an injected memory-context block. The opening
 * tag carries the turn key so a second `transform` on the SAME turn can detect
 * the prior injection and skip it (the double-injection guard, §17.4). The
 * runtime shim can strip these markers verbatim if it prefers.
 */
const MEMORY_BLOCK_OPEN = '<naru-memory'
const MEMORY_BLOCK_CLOSE = '</naru-memory>'

/**
 * Precise detector for an injected memory block (the double-injection guard,
 * §17.4). It matches the FULL rendered opening marker `<naru-memory turn="...">`
 * anchored at the start of a line — NOT a bare substring — so an incidental
 * occurrence of `<naru-memory` inside arbitrary user text or inside an injected
 * fact statement (core stores statements verbatim; the marker syntax is not a
 * secret, so redaction does not strip it) cannot trip the guard. Combined with
 * the system-role check at the call site, only a block this hook itself
 * prepended is recognized as "already injected".
 */
const MEMORY_BLOCK_MARKER_RE = /^<naru-memory turn="[^"]*">/m

/**
 * Detect an explicit memory intent in a user message (plan §17.4
 * `chat.message`). PURE: a single string in, a {@link MemoryIntent} or `null`
 * out — no I/O — so intent detection is independently unit-testable.
 *
 * Patterns (case-insensitive, explicit only — never infers from arbitrary
 * chatter, per §13.2 "capture is explicit / fire-and-forget"):
 * - remember: "remember that ...", "remember to ...", "note that ...",
 *   "make a note that ...", "keep in mind that ...".
 * - recall: "what did we decide about ...", "what do you remember about ...",
 *   "recall ...", and the bare resume verbs ("resume", "where were we",
 *   "what were we working on", "catch me up").
 *
 * Returns the captured payload trimmed; an empty payload yields `null` (nothing
 * actionable to remember/search).
 */
export function detectMemoryIntent(content: string): MemoryIntent | null {
  const text = content.trim()
  if (text.length === 0) {
    return null
  }

  // --- remember intents -------------------------------------------------
  const rememberPatterns: RegExp[] = [
    /^\s*remember\s+(?:that|to)\s+(.+)$/is,
    /^\s*(?:make\s+a\s+note|note)\s+(?:that|to)\s+(.+)$/is,
    /^\s*keep\s+in\s+mind\s+that\s+(.+)$/is,
  ]
  for (const re of rememberPatterns) {
    const m = text.match(re)
    const payload = m?.[1]?.trim()
    if (payload !== undefined && payload.length > 0) {
      return { kind: 'remember', query: payload }
    }
  }

  // --- recall intents (explicit question / resume) ----------------------
  const recallPatterns: RegExp[] = [
    /^\s*what\s+did\s+we\s+(?:decide|agree|choose|conclude)\s+(?:about|on|regarding)\s+(.+)$/is,
    /^\s*what\s+(?:do\s+you|did\s+you)\s+remember\s+(?:about|regarding)\s+(.+)$/is,
    /^\s*recall\s+(.+)$/is,
  ]
  for (const re of recallPatterns) {
    const m = text.match(re)
    const payload = m?.[1]?.trim().replace(/[?.!]+$/, '')
    if (payload !== undefined && payload.length > 0) {
      return { kind: 'recall', query: payload }
    }
  }

  // Bare resume verbs: search broadly with the whole message as the query.
  const resumeRe =
    /^\s*(?:resume|continue(?:\s+where\s+we\s+left\s+off)?|where\s+were\s+we|what\s+were\s+we\s+(?:working|doing)(?:\s+on)?|catch\s+me\s+up)\b/i
  if (resumeRe.test(text)) {
    return { kind: 'recall', query: text.replace(/[?.!]+$/, '') }
  }

  return null
}

/**
 * The default allowed READ scope set for a session (plan §9.3 read order):
 * session, agent, branch, project, workspace, user — whichever resolved. Mirrors
 * the tools' `readScopeSet`; kept local so the hooks don't reach into `tools.ts`
 * internals.
 */
function readScopeSet(resolved: ResolvedScopes): ScopeSelector[] {
  const ordered: (ScopeRef | null)[] = [
    resolved.session,
    resolved.agent,
    resolved.branch,
    resolved.project,
    resolved.workspace,
    resolved.user,
  ]
  return ordered.filter((r): r is ScopeRef => r !== null).map((r) => ({ type: r.type, key: r.key }))
}

/** The default WRITE scope (plan §9.2, §17.5): `project`. */
function defaultWriteScope(resolved: ResolvedScopes): { type: ScopeRef['type']; key: string } {
  return { type: resolved.project.type, key: resolved.project.key }
}

/**
 * The WRITE scope for transient, run-local capture (plan §9.2 memory-type→scope
 * table). A compaction summary is session/branch-adjacent state, not a durable
 * repo convention, so it must NOT default into the durable `project` scope
 * (where it would later surface to unrelated future sessions in the same repo).
 * Route it to the narrowest resolved lifetime: `session` > `branch` > `project`.
 */
function transientWriteScope(resolved: ResolvedScopes): { type: ScopeRef['type']; key: string } {
  const ref = resolved.session ?? resolved.branch ?? resolved.project
  return { type: ref.type, key: ref.key }
}

/** Ensure each writable read scope exists so a fresh session resolves it (§9.4, §11.2). */
async function ensureReadScopes(client: AdapterClient, scopes: ScopeSelector[]): Promise<void> {
  for (const s of scopes) {
    if (s.type !== 'global') {
      await client.ensureScope(s.type, s.key)
    }
  }
}

/** Map a `SearchResultItem` to the leaner {@link SurfacedMemory} shape. */
function toSurfaced(item: {
  factId: string
  statement: string
  scope: string
  score: number
}): SurfacedMemory {
  return {
    factId: item.factId,
    statement: item.statement,
    scope: item.scope,
    score: item.score,
  }
}

/**
 * Assemble the OpenCode {@link Hooks} bound to an injected {@link PluginContext}
 * (plan §17.4). PURE: every hook is driven by the injected client + scope
 * resolver + sink, so the whole set is unit-testable offline against a mock
 * context and an embedded `:memory:` Naru.
 *
 * The returned object's keys MATCH OpenCode's §17.4 hook names exactly so the
 * runtime dispatches by key. Each hook below documents the seam where the real
 * runtime payload arrives and how its return value is consumed.
 */
export function createHooks(ctx: PluginContext, options: HookOptions = {}): Hooks {
  const { client, resolveScopes } = ctx
  const sink = options.sink ?? NOOP_SINK
  const limit = options.limit ?? DEFAULT_LIMIT
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET

  /**
   * Per-turn injection guard (plan §17.4 transform: "inject EXACTLY ONCE per
   * turn"). A turn is keyed by session + the count of user messages so far —
   * the same prompt list transformed twice in one turn injects once, while the
   * next turn (one more user message) injects afresh. The marker already present
   * in the messages is the primary guard; this Set is the secondary guard for
   * runtimes that re-run transform on a copy that already had the block stripped.
   */
  const injectedTurns = new Set<string>()

  /** Resolve the scopes for a hook payload (shares the tools' input shape). */
  function scopesFor(input: {
    cwd: string
    sessionId?: string
    agentId?: string
  }): ResolvedScopes {
    return resolveScopes({
      cwd: input.cwd,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    })
  }

  /** Run a scoped, bounded search on the fast retrieval path (§13.2). */
  async function searchScoped(query: string, scopes: ScopeSelector[]): Promise<SurfacedMemory[]> {
    if (scopes.length === 0) {
      return []
    }
    await ensureReadScopes(client, scopes)
    const results = await client.search({ query, scopes, limit })
    return results.map(toSurfaced)
  }

  const hooks: Hooks = {
    /**
     * `config` (§17.4): register the eight native tools (§17.3) on the runtime
     * config. MUST NOT enable MCP (§17.2/§17.6) — we only attach `tools` and
     * never touch any `mcp` config key. The runtime owns the exact config
     * shape; we append to a `tools` array, preserving any the runtime already
     * set (config preservation, §17.6).
     */
    config(input: ConfigHookInput): void {
      const tools = createTools(ctx)
      const existing = input.config.tools
      input.config.tools = Array.isArray(existing) ? [...existing, ...tools] : tools
    },

    /**
     * `chat.message` (§17.4): detect an explicit remember/recall intent.
     * - remember -> fire-and-forget capture (core redacts + ingests, §13.2/§18.1);
     *   the agent loop is never blocked on extraction.
     * - recall -> scoped search across the resolved read set; surface the
     *   redacted hits via the sink for the runtime to inject.
     * No intent -> no-op (we never capture arbitrary chatter, §13.2).
     */
    async 'chat.message'(input: ChatMessageHookInput): Promise<void> {
      try {
        if (input.message.role !== 'user') {
          return
        }
        const intent = detectMemoryIntent(input.message.content)
        if (intent === null) {
          return
        }
        const resolved = scopesFor(input)

        if (intent.kind === 'remember') {
          // Capture into the default write scope (§9.2). Core redacts before
          // persistence; the adapter never pre-scrubs (§18.1). FIRE-AND-FORGET
          // (§13.2/§17.4): extraction may run a local LLM, so we MUST NOT await
          // it — the agent loop is never blocked on ingestion. We await only the
          // cheap scope-row ensure, then dispatch the capture without awaiting,
          // attaching `.catch` so a rejection can't become an unhandled
          // rejection (it is best-effort background ingestion).
          const scope = defaultWriteScope(resolved)
          await client.ensureScope(scope.type, scope.key)
          void client
            .captureExtract({ text: intent.query, scope, sourceType: 'manual' })
            .catch(() => {})
          return
        }

        // recall: search the resolved read set and surface the hits.
        const items = await searchScoped(intent.query, readScopeSet(resolved))
        sink.recall({ query: intent.query, items })
      } catch {
        // Integration layer must never destabilize the host loop (§17.1): a
        // detection/recall failure degrades to a no-op for this message.
      }
    },

    /**
     * `experimental.chat.messages.transform` (§17.4): inject a memory-context
     * block built from already-redacted facts EXACTLY ONCE per turn.
     *
     * Double-injection guard: the injected block is wrapped in a
     * `<naru-memory turn="...">` marker on a SYSTEM message. Before injecting we
     * check both (a) the incoming messages for an existing block — a system
     * message matching the full rendered marker (anchored, not a bare
     * substring, so attacker/content-controlled `<naru-memory` text cannot
     * suppress injection) — and (b) the per-turn guard Set; if either says
     * "already injected this turn", we return the messages untouched. If no
     * relevant memory is found, we inject nothing (return the messages as-is).
     * The returned array is what the runtime sends to the model.
     */
    async 'experimental.chat.messages.transform'(
      input: MessagesTransformHookInput,
    ): Promise<ChatMessage[]> {
      try {
        return await transform(input)
      } catch {
        // transform's return value is the prompt list sent to the model; a
        // memory-retrieval failure must NEVER break prompt assembly (§17.1).
        // Degrade to the original messages unchanged.
        return input.messages
      }
    },

    /**
     * `tool.execute.after` (§17.4): on a tool FAILURE, search prior error
     * memories / gotchas in scope and surface candidate fixes. Non-blocking and
     * fast-path only (§13.2): a successful call is a no-op; a failure runs one
     * bounded scoped search and hands the hits to the sink. Never throws back
     * into the runtime — a memory miss must not turn a tool error into a crash.
     */
    async 'tool.execute.after'(input: ToolExecuteAfterHookInput): Promise<void> {
      if (!input.error) {
        return
      }
      try {
        const resolved = scopesFor(input)
        // Query off the failing tool + its error so prior gotchas about the
        // same failure surface (the error text is the strongest signal).
        const query = `${input.tool} ${input.error.message}`.trim()
        const items = await searchScoped(query, readScopeSet(resolved))
        sink.toolError({ tool: input.tool, error: input.error.message, items })
      } catch {
        // Surfacing fixes is best-effort; never escalate a lookup failure.
      }
    },

    /**
     * `experimental.session.compacting` (§17.4): preserve memory across
     * compaction. (1) Capture the compaction summary as a FIRE-AND-FORGET
     * episode (core redacts + ingests) so salient context survives
     * summarization, scoped to its transient session/branch lifetime so it does
     * NOT bleed into the durable project scope. (2) Re-search the resolved
     * scopes off the summary and surface the prior salient context via the sink
     * so the runtime can re-inject it. Best-effort: never aborts compaction.
     */
    async 'experimental.session.compacting'(input: SessionCompactingHookInput): Promise<void> {
      try {
        const resolved = scopesFor(input)

        // (1) Capture the compaction summary as fire-and-forget background
        // ingestion (§13.2/§17.4): do NOT await — extraction may run a local
        // LLM and the agent's compaction loop must not block on it. Scope it to
        // its TRANSIENT nature (§9.2): session > branch > project, so run-local
        // state does not bleed into the durable project scope.
        const scope = transientWriteScope(resolved)
        await client.ensureScope(scope.type, scope.key)
        void client
          .captureExtract({ text: input.summary, scope, sourceType: 'summary' })
          .catch(() => {})

        // (2) Re-surface prior salient context keyed off the summary (fast read).
        const items = await searchScoped(input.summary, readScopeSet(resolved))
        sink.compaction({ items })
      } catch {
        // Best-effort: a capture/lookup failure degrades to a no-op and never
        // aborts the host's compaction phase (§17.1).
      }
    },

    /**
     * `shell.env` (§17.4): export Naru scope/session env vars for child shells
     * so shell-spawned tools can discover the same DB + scope context. Returns
     * the augmented env map (the runtime merges it into the child env). We never
     * clobber a value the runtime already set (config preservation, §17.6) and
     * never throw — on failure the env is returned unmodified (§17.1).
     */
    async 'shell.env'(input: ShellEnvHookInput): Promise<Record<string, string>> {
      try {
        const resolved = scopesFor(input)
        const status = await client.status()
        const additions: Record<string, string> = {
          NARU_DB: status.dbPath,
          NARU_SCOPE_USER: resolved.user.key,
          NARU_SCOPE_WORKSPACE: resolved.workspace.key,
          NARU_SCOPE_PROJECT: resolved.project.key,
        }
        if (resolved.branch !== null) {
          additions.NARU_SCOPE_BRANCH = resolved.branch.key
        }
        if (resolved.session !== null) {
          additions.NARU_SCOPE_SESSION = resolved.session.key
        }
        if (resolved.agent !== null) {
          additions.NARU_SCOPE_AGENT = resolved.agent.key
        }
        // Preserve any value the runtime already set; only fill what's missing.
        const merged: Record<string, string> = { ...input.env }
        for (const [k, v] of Object.entries(additions)) {
          if (merged[k] === undefined) {
            merged[k] = v
          }
        }
        return merged
      } catch {
        // Child-shell spawning must not break if status/scope resolution fails
        // (§17.1): return the env unmodified.
        return input.env
      }
    },
  }

  /**
   * The body of `experimental.chat.messages.transform`, extracted so the hook
   * itself is a thin try/catch wrapper that guarantees the prompt list is never
   * broken by a retrieval failure (returns the original messages on any throw).
   */
  async function transform(input: MessagesTransformHookInput): Promise<ChatMessage[]> {
    const turnKey = turnKeyFor(input)

    // Guard (a): a real injected block already present in this prompt list.
    // Only a SYSTEM message whose content matches the full rendered marker
    // counts — incidental `<naru-memory` substrings in user text or in an
    // injected fact statement must not suppress injection (a memory-context
    // availability bug) nor be conflated with the real marker.
    if (input.messages.some((m) => m.role === 'system' && MEMORY_BLOCK_MARKER_RE.test(m.content))) {
      injectedTurns.add(turnKey)
      return input.messages
    }
    // Guard (b): we already injected for this turn on a prior call.
    if (injectedTurns.has(turnKey)) {
      return input.messages
    }

    const query = latestUserContent(input.messages)
    if (query === null) {
      return input.messages
    }

    const resolved = scopesFor(input)
    const scopes = readScopeSet(resolved)
    if (scopes.length === 0) {
      return input.messages
    }
    await ensureReadScopes(client, scopes)
    const context = await client.buildContext({ query, scopes, tokenBudget })
    if (context.items.length === 0) {
      // No relevant memory -> inject nothing (still mark the turn so a retry
      // on the same turn doesn't re-query and risk a late double-inject).
      injectedTurns.add(turnKey)
      return input.messages
    }

    injectedTurns.add(turnKey)
    const block = renderMemoryBlock(turnKey, context.promptBlock)
    // Prepend as a system message so the model sees memory before the turn.
    return [{ role: 'system', content: block }, ...input.messages]
  }

  return hooks
}

/**
 * Turn key for the injection guard: session id (or `cwd` when sessionless) plus
 * the number of user messages seen so far. A second transform on the same turn
 * yields the same key; the next user turn yields a new one.
 */
function turnKeyFor(input: MessagesTransformHookInput): string {
  const base = input.sessionId && input.sessionId.length > 0 ? input.sessionId : input.cwd
  const userCount = input.messages.filter((m) => m.role === 'user').length
  return `${base}#${userCount}`
}

/** The most recent user message content, or `null` if there is none. */
function latestUserContent(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === 'user' && m.content.trim().length > 0) {
      return m.content
    }
  }
  return null
}

/** Wrap a built context block in the turn-keyed memory marker (§17.4 guard). */
function renderMemoryBlock(turnKey: string, promptBlock: string): string {
  return `${MEMORY_BLOCK_OPEN} turn="${turnKey}">\n${promptBlock}\n${MEMORY_BLOCK_CLOSE}`
}

/** Re-export for tests/installer that assert on the registered tool set. */
export type { ToolDefinition }

/**
 * The REAL OpenCode plugin for Naru Memory (`@opencode-ai/plugin`).
 *
 * This is the production surface OpenCode actually loads. A plugin is
 * `Plugin = (input: PluginInput, options?) => Promise<Hooks>`; OpenCode resolves
 * a NAMED exported `Plugin` const (and we also default-export it). The plugin
 * registers the eight native memory tools (via the official `tool()` helper) and
 * five lifecycle hooks that detect remember/recall intent, inject memory context,
 * surface prior fixes after tool errors, preserve context across compaction, and
 * export scope env vars for child shells.
 *
 * RUNTIME CONSTRAINT (Bun): OpenCode runs on Bun, where the native
 * `better-sqlite3` will not load. This plugin is therefore REMOTE-ONLY — it talks
 * to a running `naru serve` over tRPC through {@link createRemoteClient} (in
 * `./remote`). It imports ONLY: `@opencode-ai/plugin` (peer, provided by
 * opencode), `./remote` (which pulls only `@trpc/client` + a TYPE-ONLY
 * `@naru/api`), `./scope` (node:child_process git — fine under Bun), and node
 * builtins. It MUST NOT import `@naru/core`, `@naru/store-sqlite`, or the
 * `@naru/server` barrel (all pull `better-sqlite3`). The built `dist/opencode.js`
 * is grepped to prove it contains no `better-sqlite3`.
 *
 * DEFENSIVENESS: every hook body is wrapped so a remote/connection error NEVER
 * throws into the opencode host loop (catch + ignore). Tools map a
 * {@link NoServerError} to a friendly "run `naru serve`" string rather than
 * throwing. All reads return already-redacted facts from the server, so no raw
 * secret is ever surfaced or injected.
 *
 * TESTABILITY: {@link NaruMemory} delegates to {@link buildNaruHooks}, which takes
 * an INJECTED {@link RemoteClient} + scope resolver. Unit tests construct the
 * hooks with a fake client and assert behavior with NO network and NO opencode
 * runtime.
 */

import type { Hooks, Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
import { NO_SERVER_MESSAGE, type RemoteClient, createRemoteClient, isNoServerError } from './remote'
import { type ResolveScopesInput, type ResolvedScopes, type ScopeRef, resolveScopes } from './scope'

/**
 * The scope resolver seam: a function `(input) => ResolvedScopes`. Defaults to
 * the real git-backed {@link resolveScopes}; tests inject a deterministic stub.
 */
export type ScopeResolver = (input: ResolveScopesInput) => ResolvedScopes

/**
 * Dependencies for {@link buildNaruHooks}. The plugin entrypoint builds these
 * from the live {@link PluginInput} + options; tests inject fakes directly so the
 * whole hook/tool set is exercised offline.
 */
export interface NaruHookDeps {
  /** Remote memory client (lazy + graceful; no-server surfaces as a friendly message). */
  client: RemoteClient
  /** The session/workspace directory used as the cwd for scope resolution. */
  directory: string
  /** Scope resolver (defaults to the real git-backed resolver). */
  resolveScopes?: ScopeResolver
  /** Bound server URL, when known, exported via `shell.env` (best-effort). */
  serverUrl?: string
}

/** A `type:key` scope selector understood by the server's procedures. */
interface ScopeSelectorArg {
  type: 'user' | 'workspace' | 'project' | 'branch' | 'session' | 'agent' | 'global'
  key: string
}

/** A writable `type:key` scope selector (no `global`, which is a read alias). */
interface WritableScopeSelectorArg {
  type: 'user' | 'workspace' | 'project' | 'branch' | 'session' | 'agent'
  key: string
}

/** Max items a hook lookup surfaces — keeps injected context bounded + fast. */
const DEFAULT_LIMIT = 5
/** Token budget for the injected memory-context block (matches core's default). */
const DEFAULT_TOKEN_BUDGET = 1024

/** Marker wrapping an injected memory-context message (the double-injection guard). */
const MEMORY_BLOCK_OPEN = '<naru-memory>'
const MEMORY_BLOCK_CLOSE = '</naru-memory>'

// ---------------------------------------------------------------------------
// scope helpers (mirrors tools.ts / hooks.ts behavior, rebuilt on remote types)
// ---------------------------------------------------------------------------

/** Convert a {@link ScopeRef} to a plain selector. */
function toSelector(ref: ScopeRef): WritableScopeSelectorArg {
  return { type: ref.type, key: ref.key }
}

/**
 * The default allowed READ scope set for a session (plan §9.3 read order):
 * session, agent, branch, project, workspace, user — whichever resolved.
 */
function readScopeSet(resolved: ResolvedScopes): WritableScopeSelectorArg[] {
  const ordered: (ScopeRef | null)[] = [
    resolved.session,
    resolved.agent,
    resolved.branch,
    resolved.project,
    resolved.workspace,
    resolved.user,
  ]
  return ordered.filter((r): r is ScopeRef => r !== null).map(toSelector)
}

/** The default WRITE scope (plan §9.2, §17.5): `project`. */
function defaultWriteScope(resolved: ResolvedScopes): WritableScopeSelectorArg {
  return { type: resolved.project.type, key: resolved.project.key }
}

/**
 * The WRITE scope for transient, run-local capture (a compaction summary is
 * session/branch-adjacent state, not a durable repo convention): narrowest
 * resolved lifetime session > branch > project.
 */
function transientWriteScope(resolved: ResolvedScopes): WritableScopeSelectorArg {
  const ref = resolved.session ?? resolved.branch ?? resolved.project
  return { type: ref.type, key: ref.key }
}

/** Ensure each writable read scope exists so a fresh session resolves it (§9.4, §11.2). */
async function ensureReadScopes(
  client: RemoteClient,
  scopes: WritableScopeSelectorArg[],
): Promise<void> {
  for (const s of scopes) {
    await client.ensureScope(s)
  }
}

// ---------------------------------------------------------------------------
// intent detection (preserved verbatim from hooks.ts)
// ---------------------------------------------------------------------------

/** A classified memory intent detected in a user message. */
export interface MemoryIntent {
  kind: 'remember' | 'recall'
  /** The salient payload: the thing to remember, or the recall query. */
  query: string
}

/**
 * Detect an explicit memory intent in a user message (preserved from the prior
 * adapter). PURE: a single string in, a {@link MemoryIntent} or `null` out.
 * Explicit patterns only — never infers from arbitrary chatter.
 */
export function detectMemoryIntent(content: string): MemoryIntent | null {
  const text = content.trim()
  if (text.length === 0) {
    return null
  }

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

  const resumeRe =
    /^\s*(?:resume|continue(?:\s+where\s+we\s+left\s+off)?|where\s+were\s+we|what\s+were\s+we\s+(?:working|doing)(?:\s+on)?|catch\s+me\s+up)\b/i
  if (resumeRe.test(text)) {
    return { kind: 'recall', query: text.replace(/[?.!]+$/, '') }
  }

  return null
}

// ---------------------------------------------------------------------------
// rendering helpers (concise, human-readable tool output)
// ---------------------------------------------------------------------------

/** Whether a tool output looks like an error (drives the prior-fix lookup). */
function looksLikeError(text: string): boolean {
  return /\b(error|exception|failed|failure|traceback|cannot|not found|denied|fatal)\b/i.test(text)
}

/** Render a search/context result list as concise human-readable lines. */
function renderHits(
  hits: ReadonlyArray<{ statement: string; scope: string; score: number }>,
): string {
  if (hits.length === 0) {
    return 'No matching memories.'
  }
  return hits
    .map((h, i) => `${i + 1}. [${h.scope}] ${h.statement} (score ${h.score.toFixed(2)})`)
    .join('\n')
}

/** Friendly message for a no-server condition, given a thrown error. */
function noServerMessage(err: unknown): string {
  return isNoServerError(err) ? err.message : NO_SERVER_MESSAGE
}

// ---------------------------------------------------------------------------
// the eight native tools
// ---------------------------------------------------------------------------

/**
 * Build the eight native memory tools bound to an injected {@link RemoteClient}
 * + scope resolver. Each `execute` returns a concise human-readable string (or
 * `{ output, metadata }` for structured results). On a no-server condition every
 * tool returns the friendly "run `naru serve`" message instead of throwing.
 */
function buildTools(deps: NaruHookDeps): NonNullable<Hooks['tool']> {
  const { client } = deps
  const resolve = deps.resolveScopes ?? resolveScopes
  const z = tool.schema

  /** Resolve the active scope set for a tool call (uses the plugin `directory`). */
  function resolved(): ResolvedScopes {
    return resolve({ cwd: deps.directory })
  }

  const scopeArg = z
    .object({
      type: z.enum(['user', 'workspace', 'project', 'branch', 'session', 'agent']),
      key: z.string().min(1),
    })
    .describe('Explicit scope `{ type, key }` to target instead of the default.')

  const add_memory = tool({
    description:
      'Store a durable memory (fact) for later recall. Defaults to the project scope; ' +
      'secrets are redacted before storage.',
    args: {
      text: z.string().min(1).describe('The memory text to store.'),
      scope: scopeArg.optional(),
      subject: z.string().optional().describe('Optional triple subject.'),
      predicate: z.string().optional().describe('Optional triple predicate.'),
      object: z.string().optional().describe('Optional triple object.'),
      confidence: z.number().min(0).max(1).optional().describe('Optional confidence 0..1.'),
    },
    async execute(args) {
      try {
        const scope: WritableScopeSelectorArg = args.scope
          ? { type: args.scope.type, key: args.scope.key }
          : defaultWriteScope(resolved())
        await client.ensureScope(scope)
        const fact = await client.addMemory({
          text: args.text,
          scope,
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          ...(args.predicate !== undefined ? { predicate: args.predicate } : {}),
          ...(args.object !== undefined ? { object: args.object } : {}),
          ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
        })
        return {
          output: `Stored memory in ${scope.type}:${scope.key}: ${fact.statement}`,
          metadata: { factId: fact.id, scope: `${scope.type}:${scope.key}` },
        }
      } catch (err) {
        return noServerMessage(err)
      }
    },
  })

  const search_memories = tool({
    description:
      'Search stored memories relevant to a query within the current scope set. ' +
      'Pass `global: true` to search across all projects.',
    args: {
      query: z.string().min(1).describe('What to search for.'),
      scope: scopeArg.optional(),
      global: z.boolean().optional().describe('Search across all projects.'),
      limit: z.number().int().positive().optional().describe('Max results.'),
      includeHistory: z.boolean().optional().describe('Include superseded facts.'),
    },
    async execute(args) {
      try {
        const r = resolved()
        const scopes = args.scope
          ? [{ type: args.scope.type, key: args.scope.key }]
          : readScopeSet(r)
        if (!args.global) {
          await ensureReadScopes(client, scopes)
        }
        const results = await client.search({
          query: args.query,
          ...(args.global
            ? { global: true, globalUser: r.user.key }
            : { scopes: scopes as ScopeSelectorArg[] }),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.includeHistory ? { includeHistory: true } : {}),
        })
        return {
          output: `${results.length} result(s)\n${renderHits(results)}`,
          metadata: { count: results.length },
        }
      } catch (err) {
        return noServerMessage(err)
      }
    },
  })

  const get_memories = tool({
    description:
      'List stored memories (facts) by scope and status without a query. ' +
      'Defaults to active facts in the project scope.',
    args: {
      scope: scopeArg.optional(),
      status: z
        .enum(['active', 'superseded', 'deleted', 'rejected', 'archived'])
        .optional()
        .describe('Fact status filter (default active).'),
      limit: z.number().int().positive().optional().describe('Max facts.'),
    },
    async execute(args) {
      try {
        const r = resolved()
        const scope: WritableScopeSelectorArg = args.scope
          ? { type: args.scope.type, key: args.scope.key }
          : toSelector(r.project)
        await client.ensureScope(scope)
        const facts = await client.list({
          scope: scope as ScopeSelectorArg,
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        })
        const lines =
          facts.length === 0
            ? 'No memories.'
            : facts.map((f, i) => `${i + 1}. ${f.statement}`).join('\n')
        return {
          output: `${facts.length} fact(s) in ${scope.type}:${scope.key}\n${lines}`,
          metadata: { count: facts.length, scope: `${scope.type}:${scope.key}` },
        }
      } catch (err) {
        return noServerMessage(err)
      }
    },
  })

  const get_memory = tool({
    description: 'Get a single memory (fact) with its evidence by id.',
    args: { id: z.string().min(1).describe('The fact id.') },
    async execute(args) {
      try {
        const found = await client.get(args.id)
        if (!found) {
          return `No memory found with id ${args.id}.`
        }
        return {
          output: `${found.fact.statement}\n(evidence: ${found.evidence.length} item(s))`,
          metadata: { factId: found.fact.id, evidenceCount: found.evidence.length },
        }
      } catch (err) {
        return noServerMessage(err)
      }
    },
  })

  const forget_memory = tool({
    description:
      'Permanently delete memories by selector (fact/entity/episode id, scope, or ' +
      'date range) for privacy. This is destructive. A single `factId` is a targeted ' +
      'delete; ANY broader selector (entity/episode/scope/date range) is a bulk delete ' +
      'and requires `confirm: true`.',
    args: {
      factId: z.string().min(1).optional().describe('Target a single fact.'),
      entityId: z.string().min(1).optional().describe('Delete facts for an entity (bulk).'),
      episodeId: z.string().min(1).optional().describe('Delete by episode (bulk).'),
      scope: scopeArg.optional(),
      before: z.string().optional().describe('Delete facts observed before this ISO time (bulk).'),
      after: z.string().optional().describe('Delete facts observed after this ISO time (bulk).'),
      confirm: z.boolean().optional().describe('Required to confirm a bulk delete.'),
    },
    async execute(args) {
      const hasSelector =
        args.factId !== undefined ||
        args.entityId !== undefined ||
        args.episodeId !== undefined ||
        args.scope !== undefined ||
        args.before !== undefined ||
        args.after !== undefined
      if (!hasSelector) {
        return 'forget_memory: at least one selector (factId/entityId/episodeId/scope/before/after) is required.'
      }
      const isSingleId =
        args.factId !== undefined &&
        args.entityId === undefined &&
        args.episodeId === undefined &&
        args.scope === undefined &&
        args.before === undefined &&
        args.after === undefined
      if (!isSingleId && args.confirm !== true) {
        return 'forget_memory: this is a bulk delete — pass `confirm: true` to proceed.'
      }
      try {
        const result = await client.forget({
          ...(args.factId !== undefined ? { factId: args.factId } : {}),
          ...(args.entityId !== undefined ? { entityId: args.entityId } : {}),
          ...(args.episodeId !== undefined ? { episodeId: args.episodeId } : {}),
          ...(args.scope !== undefined
            ? { scope: { type: args.scope.type, key: args.scope.key } }
            : {}),
          ...(args.before !== undefined ? { before: args.before } : {}),
          ...(args.after !== undefined ? { after: args.after } : {}),
        })
        return {
          output: `Deleted ${result.deleted} memory item(s).`,
          metadata: { deleted: result.deleted },
        }
      } catch (err) {
        return noServerMessage(err)
      }
    },
  })

  const build_memory_context = tool({
    description:
      'Build a token-bounded prompt context block of the most relevant memories for ' +
      'a query/task within the current scope set.',
    args: {
      query: z.string().min(1).describe('The task/query to build context for.'),
      scope: scopeArg.optional(),
      global: z.boolean().optional().describe('Pull context across all projects.'),
      limit: z.number().int().positive().optional().describe('Max items.'),
      tokenBudget: z.number().int().positive().optional().describe('Token budget for the block.'),
      includeHistory: z.boolean().optional().describe('Include superseded facts.'),
    },
    async execute(args) {
      try {
        const r = resolved()
        const scopes = args.scope
          ? [{ type: args.scope.type, key: args.scope.key }]
          : readScopeSet(r)
        if (!args.global) {
          await ensureReadScopes(client, scopes)
        }
        const result = await client.buildContext({
          query: args.query,
          ...(args.global
            ? { global: true, globalUser: r.user.key }
            : { scopes: scopes as ScopeSelectorArg[] }),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
          ...(args.includeHistory ? { includeHistory: true } : {}),
        })
        return {
          output: result.promptBlock.length > 0 ? result.promptBlock : 'No relevant memory.',
          metadata: { items: result.items.length, tokenEstimate: result.tokenEstimate },
        }
      } catch (err) {
        return noServerMessage(err)
      }
    },
  })

  const list_entities = tool({
    description: 'List known entities (people, repos, tools, concepts) in a scope.',
    args: { scope: scopeArg.optional() },
    async execute(args) {
      try {
        const r = resolved()
        const scope: WritableScopeSelectorArg = args.scope
          ? { type: args.scope.type, key: args.scope.key }
          : toSelector(r.project)
        await client.ensureScope(scope)
        const entities = await client.listEntities({ scope: scope as ScopeSelectorArg })
        const lines =
          entities.length === 0
            ? 'No entities.'
            : entities.map((e, i) => `${i + 1}. ${e.type}: ${e.canonicalName}`).join('\n')
        return {
          output: `${entities.length} entity(ies) in ${scope.type}:${scope.key}\n${lines}`,
          metadata: { count: entities.length, scope: `${scope.type}:${scope.key}` },
        }
      } catch (err) {
        return noServerMessage(err)
      }
    },
  })

  const memory_status = tool({
    description:
      'Report Naru memory status: DB path, counts, retention mode, provider ' +
      'features, and whether a running server was reachable.',
    args: {},
    async execute() {
      try {
        const status = await client.status()
        return {
          output: [
            'Naru memory: server reachable.',
            `DB: ${status.dbPath}`,
            `Facts: ${status.counts.facts}, entities: ${status.counts.entities}, episodes: ${status.counts.episodes}, scopes: ${status.counts.scopes}`,
            `Retention: ${status.retentionMode}`,
            `Extractor: ${status.features.extractor.available ? 'available' : 'unavailable'}; vector embedder: ${status.features.vector.embedder.available ? 'available' : 'unavailable'}`,
          ].join('\n'),
          metadata: { reachable: true, counts: status.counts },
        }
      } catch (err) {
        return {
          output: `Naru memory: no server reachable. ${noServerMessage(err)}`,
          metadata: { reachable: false },
        }
      }
    },
  })

  return {
    add_memory,
    search_memories,
    get_memories,
    get_memory,
    forget_memory,
    build_memory_context,
    list_entities,
    memory_status,
  }
}

// ---------------------------------------------------------------------------
// the hooks
// ---------------------------------------------------------------------------

/** Extract the concatenated text of a message's `text` parts. */
function textOfParts(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter(
      (p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string',
    )
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/**
 * Assemble the OpenCode {@link Hooks} from injected dependencies. PURE: every
 * hook is driven by the injected client + scope resolver, so the whole set is
 * unit-testable offline against a fake client. Each hook body is wrapped so a
 * remote/connection error never throws into the opencode host loop.
 */
export function buildNaruHooks(deps: NaruHookDeps): Hooks {
  const { client } = deps
  const resolve = deps.resolveScopes ?? resolveScopes
  const directory = deps.directory

  /** Resolve the active scope set for the plugin's directory. */
  function resolved(): ResolvedScopes {
    return resolve({ cwd: directory })
  }

  /** Run a scoped, bounded search on the fast retrieval path. */
  async function searchScoped(
    query: string,
    scopes: WritableScopeSelectorArg[],
  ): Promise<Array<{ statement: string; scope: string; score: number }>> {
    if (scopes.length === 0) {
      return []
    }
    await ensureReadScopes(client, scopes)
    return client.search({ query, scopes: scopes as ScopeSelectorArg[], limit: DEFAULT_LIMIT })
  }

  return {
    tool: buildTools(deps),

    /**
     * `chat.message`: detect an explicit remember/recall intent in the user
     * message text parts. A "remember ..." capture is fire-and-forget (never
     * blocks; errors swallowed). Cheap: only runs when an intent matches.
     */
    async 'chat.message'(_input, output): Promise<void> {
      try {
        if (output.message.role !== 'user') {
          return
        }
        const text = textOfParts(output.parts)
        const intent = detectMemoryIntent(text)
        if (intent === null || intent.kind !== 'remember') {
          // recall is handled by the transform hook (context injection); here we
          // only act on explicit captures so the message loop stays cheap.
          return
        }
        const scope = defaultWriteScope(resolved())
        // Fire-and-forget: do NOT await — extraction may run a local LLM and the
        // agent loop must never block on ingestion. Swallow errors (best-effort).
        void client
          .ensureScope(scope)
          .then(() => client.capture({ text: intent.query, scope, sourceType: 'manual' }))
          .catch(() => {})
      } catch {
        // Integration layer must never destabilize the host loop.
      }
    },

    /**
     * `experimental.chat.messages.transform`: inject a memory-context block ONCE
     * per call by MUTATING `output.messages`. Build the block from
     * `client.buildContext` on the latest user text. If no server or no relevant
     * memory, inject nothing. Guard against double-injection within the same
     * output (a prior injected block already present).
     */
    async 'experimental.chat.messages.transform'(_input, output): Promise<void> {
      try {
        // Double-injection guard: a block this hook prepended is already present.
        const already = output.messages.some((m) =>
          m.parts.some(
            (p) =>
              p.type === 'text' &&
              typeof p.text === 'string' &&
              p.text.startsWith(MEMORY_BLOCK_OPEN),
          ),
        )
        if (already) {
          return
        }

        // Latest user message text (scan from the end).
        let query: string | null = null
        for (let i = output.messages.length - 1; i >= 0; i--) {
          const m = output.messages[i]
          if (m !== undefined && m.info.role === 'user') {
            const t = textOfParts(m.parts)
            if (t.length > 0) {
              query = t
              break
            }
          }
        }
        if (query === null) {
          return
        }

        const r = resolved()
        const scopes = readScopeSet(r)
        if (scopes.length === 0) {
          return
        }
        await ensureReadScopes(client, scopes)
        const context = await client.buildContext({
          query,
          scopes: scopes as ScopeSelectorArg[],
          tokenBudget: DEFAULT_TOKEN_BUDGET,
        })
        if (context.items.length === 0 || context.promptBlock.length === 0) {
          return
        }

        // Inject a synthesized system message at the front. The marker lets a
        // re-run on the same output detect the prior injection and skip it.
        const blockText = `${MEMORY_BLOCK_OPEN}\n${context.promptBlock}\n${MEMORY_BLOCK_CLOSE}`
        const anchor = output.messages[0]
        if (anchor === undefined) {
          return
        }
        const now = Date.now()
        output.messages.unshift({
          info: {
            id: `naru-memory-${now}`,
            sessionID: anchor.info.sessionID,
            role: 'user',
            time: { created: now },
            agent: '',
            model: { providerID: '', modelID: '' },
          },
          parts: [
            {
              id: `naru-memory-part-${now}`,
              sessionID: anchor.info.sessionID,
              messageID: `naru-memory-${now}`,
              type: 'text',
              text: blockText,
              synthetic: true,
            },
          ],
        })
      } catch {
        // A retrieval failure must NEVER break prompt assembly: leave messages as-is.
      }
    },

    /**
     * `tool.execute.after`: on an error-looking tool output, best-effort search
     * prior fixes and append a short hint to `output.metadata`. Never throws,
     * never blocks hard.
     */
    async 'tool.execute.after'(input, output): Promise<void> {
      try {
        const text = `${output.title ?? ''}\n${output.output ?? ''}`
        if (!looksLikeError(text)) {
          return
        }
        const r = resolved()
        const query = `${input.tool} ${output.output ?? ''}`.trim()
        const hits = await searchScoped(query, readScopeSet(r))
        if (hits.length === 0) {
          return
        }
        const hint = hits
          .slice(0, 3)
          .map((h) => `- [${h.scope}] ${h.statement}`)
          .join('\n')
        const meta = (output.metadata ?? {}) as Record<string, unknown>
        meta.naruMemoryHint = `Naru memory may help here:\n${hint}`
        output.metadata = meta
      } catch {
        // Surfacing fixes is best-effort; never escalate a lookup failure.
      }
    },

    /**
     * `experimental.session.compacting`: push a few salient memory-context
     * strings into `output.context` (from `client.buildContext`). Best-effort.
     * Also fire-and-forget captures the prior context to its transient scope.
     */
    async 'experimental.session.compacting'(_input, output): Promise<void> {
      try {
        const r = resolved()
        const scopes = readScopeSet(r)
        if (scopes.length === 0) {
          return
        }
        await ensureReadScopes(client, scopes)
        // Build context off the most salient resolved scope key as the query
        // seed (no chat text is available here); the server ranks within scope.
        const seed = r.project.key
        const context = await client.buildContext({
          query: seed,
          scopes: scopes as ScopeSelectorArg[],
          tokenBudget: DEFAULT_TOKEN_BUDGET,
          limit: DEFAULT_LIMIT,
        })
        if (context.items.length === 0) {
          return
        }
        for (const item of context.items.slice(0, DEFAULT_LIMIT)) {
          output.context.push(`[${item.scope}] ${item.statement}`)
        }
      } catch {
        // Best-effort: never abort the host's compaction phase.
      }
    },

    /**
     * `shell.env`: set `NARU_SERVER_URL` (if known) and NARU scope-hint vars into
     * `output.env` for child shells. Best-effort; never clobbers an existing value.
     */
    async 'shell.env'(input, output): Promise<void> {
      try {
        const r = resolve({ cwd: input.cwd || directory })
        const additions: Record<string, string> = {
          NARU_SCOPE_USER: r.user.key,
          NARU_SCOPE_WORKSPACE: r.workspace.key,
          NARU_SCOPE_PROJECT: r.project.key,
        }
        if (deps.serverUrl !== undefined && deps.serverUrl.length > 0) {
          additions.NARU_SERVER_URL = deps.serverUrl
        }
        if (r.branch !== null) {
          additions.NARU_SCOPE_BRANCH = r.branch.key
        }
        for (const [k, v] of Object.entries(additions)) {
          if (output.env[k] === undefined) {
            output.env[k] = v
          }
        }
      } catch {
        // Child-shell spawning must not break if scope resolution fails.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// the plugin entrypoint
// ---------------------------------------------------------------------------

/**
 * Read explicit server coordinates from the plugin `options` (the opencode
 * config may pass `{ url, token }`), returning `undefined` when not both present
 * so the remote client falls back to env / discovery.
 */
function serverFromOptions(options?: PluginOptions): { url: string; token: string } | undefined {
  if (options === undefined) {
    return undefined
  }
  const url = typeof options.url === 'string' ? options.url : undefined
  const token = typeof options.token === 'string' ? options.token : undefined
  if (url !== undefined && url.length > 0 && token !== undefined && token.length > 0) {
    return { url, token }
  }
  return undefined
}

/**
 * The Naru Memory OpenCode plugin (the real `@opencode-ai/plugin` surface).
 *
 * OpenCode loads a NAMED exported `Plugin` const; we also default-export it.
 * Builds a remote client from the plugin options (`{ url, token }`) else
 * env/discovery, resolves scopes from `input.directory`, and returns the hooks
 * (8 tools + 5 lifecycle hooks). Logs a one-line load marker so loading is
 * observable.
 */
export const NaruMemory: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const server = serverFromOptions(options)
  const client = createRemoteClient(server !== undefined ? { server } : {})
  // The bound server URL (when explicit) is exported via shell.env; otherwise it
  // is resolved lazily by the remote client and not known up front.
  console.error('[naru] opencode plugin loaded')
  return buildNaruHooks({
    client,
    directory: input.directory,
    ...(server !== undefined ? { serverUrl: server.url } : {}),
  })
}

export default NaruMemory

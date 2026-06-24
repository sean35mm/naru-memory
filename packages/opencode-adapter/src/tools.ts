/**
 * The eight native OpenCode tools (plan §17.3) as {@link ToolDefinition}s.
 *
 * Each tool is a PURE function over the injected {@link PluginContext}: it
 * validates its args with zod, resolves the active scope set via
 * {@link resolveScopes} (§17.5), maps to the Naru {@link AdapterClient}, and
 * returns a structured result. The tools own NO memory logic (§17.2) — scope
 * safety (§9.4), redaction (§18.1), dedupe/supersession (§13), and ranking
 * (§14) all live in core/server and are reached through the client.
 *
 * Scope policy (plan §17.5, §9.2/§9.3):
 * - WRITES (`add_memory`) default to the `project` scope, the §9.2 default for
 *   repo conventions; an explicit `scope` arg overrides it (never `global`,
 *   which is a read alias only).
 * - READS (`search_memories`, `get_memories`, `build_memory_context`,
 *   `list_entities`) honor the full resolved scope set by default and accept a
 *   `scope` narrowing or a `global: true` opt-in (§9.3). A `global` read is
 *   bounded to the resolved user via `globalUser` so the user-typed half of the
 *   expansion stays the current user's. LIMITATION (shared DB): project scopes
 *   carry no user-ownership edge in the store yet, so the project half of a
 *   `global` read is NOT user-bounded — on a single shared Naru DB a `global`
 *   read can still surface other users' PROJECT facts (their `user` facts are
 *   excluded). On the default per-user local DB this is moot. See
 *   `scope-service.ts` `resolveAllowedScopes` for the core expansion.
 *
 * The write path relies on core redaction: `add_memory` passes text straight to
 * `client.addMemory`, which redacts before persistence (§18.1) — the adapter
 * does NOT pre-scrub or bypass it.
 */

import type { ScopeSelector, WritableScopeSelector } from '@naru/core'
import type { Fact } from '@naru/schema'
import { z } from 'zod'
import type { AdapterClient } from './client'
import type { ResolveScopesInput, ResolvedScopes, ScopeRef } from './scope'
import type { PluginContext, ToolContext, ToolDefinition } from './types'

/** A `type:key` scope arg accepted by tools that narrow the scope set. */
const scopeArgSchema = z
  .object({
    type: z.enum(['user', 'workspace', 'project', 'branch', 'session', 'agent']),
    key: z.string().min(1),
  })
  .strict()

type ScopeArg = z.infer<typeof scopeArgSchema>

const addMemoryArgs = z
  .object({
    text: z.string().min(1),
    scope: scopeArgSchema.optional(),
    subject: z.string().optional(),
    predicate: z.string().optional(),
    object: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()

const searchArgs = z
  .object({
    query: z.string().min(1),
    scope: scopeArgSchema.optional(),
    global: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    includeHistory: z.boolean().optional(),
  })
  .strict()

const getMemoriesArgs = z
  .object({
    scope: scopeArgSchema.optional(),
    status: z.enum(['active', 'superseded', 'deleted', 'rejected', 'archived']).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict()

const getMemoryArgs = z.object({ id: z.string().min(1) }).strict()

const forgetArgs = z
  .object({
    factId: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
    episodeId: z.string().min(1).optional(),
    scope: scopeArgSchema.optional(),
    before: z.string().optional(),
    after: z.string().optional(),
    /**
     * Required to confirm a BULK delete (any selector other than a single
     * `factId`). Mirrors the CLI's `--yes` gate (plan §18.2) so a model cannot
     * purge a whole scope or date range without an explicit confirmation arg.
     */
    confirm: z.boolean().optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.factId !== undefined ||
      a.entityId !== undefined ||
      a.episodeId !== undefined ||
      a.scope !== undefined ||
      a.before !== undefined ||
      a.after !== undefined,
    { message: 'forget_memory: at least one selector is required' },
  )

const buildContextArgs = z
  .object({
    query: z.string().min(1),
    scope: scopeArgSchema.optional(),
    global: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    tokenBudget: z.number().int().positive().optional(),
    includeHistory: z.boolean().optional(),
  })
  .strict()

const listEntitiesArgs = z.object({ scope: scopeArgSchema.optional() }).strict()

const statusArgs = z.object({}).strict()

/** Convert a {@link ScopeRef} to a plain `ScopeSelector`. */
function toSelector(ref: ScopeRef): ScopeSelector {
  return { type: ref.type, key: ref.key }
}

/**
 * The default allowed READ scope set for a session (plan §9.3 read order):
 * session, agent, branch, project, workspace, user — whichever resolved.
 * Returned as `ScopeSelector[]` for the client's `scopes` field.
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
  return ordered.filter((r): r is ScopeRef => r !== null).map(toSelector)
}

/**
 * The default WRITE scope for the adapter (plan §9.2, §17.5): `project`.
 * Captured/added memory defaults to repo conventions unless the caller picks a
 * different (writable) scope.
 */
function defaultWriteScope(resolved: ResolvedScopes): WritableScopeSelector {
  return { type: resolved.project.type, key: resolved.project.key }
}

/**
 * Narrow a tool's `scope` arg to a WRITE target. `global` is rejected at the
 * schema level (it is not in {@link scopeArgSchema}); this also rejects any
 * value that slipped through, mirroring the CLI's `requireWritableScope`.
 */
function asWriteScope(arg: ScopeArg): WritableScopeSelector {
  return { type: arg.type as WritableScopeSelector['type'], key: arg.key }
}

/** Build the {@link ResolveScopesInput} for a tool invocation from its context. */
function scopeInputFor(ctx: ToolContext): ResolveScopesInput {
  return {
    cwd: ctx.cwd,
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
  }
}

/** Ensure every write-target scope row exists so writes/reads resolve it (§11.2). */
async function ensureScope(client: AdapterClient, scope: WritableScopeSelector): Promise<void> {
  await client.ensureScope(scope.type, scope.key)
}

/**
 * Ensure the resolved read scopes exist as rows so a read against a fresh
 * session/branch resolves them instead of silently returning empty (§9.4). Only
 * writable scope types are ensured (all read scopes here are writable types).
 */
async function ensureReadScopes(client: AdapterClient, scopes: ScopeSelector[]): Promise<void> {
  for (const s of scopes) {
    if (s.type !== 'global') {
      await client.ensureScope(s.type as WritableScopeSelector['type'], s.key)
    }
  }
}

/** Structured result of `add_memory`. */
export interface AddMemoryResult {
  fact: Fact
  scope: string
}

/**
 * Assemble the eight native tools bound to an injected {@link PluginContext}
 * (plan §17.3). The returned array is what the `config` hook advertises to
 * OpenCode. Pure: all state comes from `ctx` (the client + scope resolver) and
 * the per-call {@link ToolContext}.
 */
export function createTools(ctx: PluginContext): ToolDefinition[] {
  const { client, resolveScopes } = ctx

  const add_memory: ToolDefinition<AddMemoryResult> = {
    name: 'add_memory',
    description:
      'Store a durable memory (fact) for later recall. Defaults to the project scope; ' +
      'secrets are redacted before storage.',
    parameters: addMemoryArgs as unknown as Record<string, unknown>,
    async execute(rawArgs, toolCtx): Promise<AddMemoryResult> {
      const args = addMemoryArgs.parse(rawArgs)
      const resolved = resolveScopes(scopeInputFor(toolCtx))
      const scope = args.scope ? asWriteScope(args.scope) : defaultWriteScope(resolved)
      await ensureScope(client, scope)
      const fact = await client.addMemory({
        text: args.text,
        scope,
        ...(args.subject !== undefined ? { subject: args.subject } : {}),
        ...(args.predicate !== undefined ? { predicate: args.predicate } : {}),
        ...(args.object !== undefined ? { object: args.object } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      })
      return { fact, scope: `${scope.type}:${scope.key}` }
    },
  }

  const search_memories: ToolDefinition = {
    name: 'search_memories',
    description:
      'Search stored memories relevant to a query within the current scope set. ' +
      'Pass `global: true` to search across all projects.',
    parameters: searchArgs as unknown as Record<string, unknown>,
    async execute(rawArgs, toolCtx) {
      const args = searchArgs.parse(rawArgs)
      const resolved = resolveScopes(scopeInputFor(toolCtx))
      const scopes = args.scope ? [toSelector(args.scope)] : readScopeSet(resolved)
      if (!args.global) {
        await ensureReadScopes(client, scopes)
      }
      const results = await client.search({
        query: args.query,
        // Bound a `global` read to the resolved user so the user-typed half of
        // the expansion stays this user's (plan §9.1, finding: shared-DB leak).
        ...(args.global ? { global: true, globalUser: resolved.user.key } : { scopes }),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.includeHistory ? { includeHistory: true } : {}),
      })
      return { results, count: results.length }
    },
  }

  const get_memories: ToolDefinition = {
    name: 'get_memories',
    description:
      'List stored memories (facts) by scope and status without a query. ' +
      'Defaults to active facts in the project scope.',
    parameters: getMemoriesArgs as unknown as Record<string, unknown>,
    async execute(rawArgs, toolCtx) {
      const args = getMemoriesArgs.parse(rawArgs)
      const resolved = resolveScopes(scopeInputFor(toolCtx))
      const scope: ScopeSelector = args.scope
        ? toSelector(args.scope)
        : toSelector(resolved.project)
      if (scope.type !== 'global') {
        await client.ensureScope(scope.type as WritableScopeSelector['type'], scope.key)
      }
      const facts = await client.list({
        scope,
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })
      return { facts, count: facts.length, scope: `${scope.type}:${scope.key}` }
    },
  }

  const get_memory: ToolDefinition = {
    name: 'get_memory',
    description: 'Get a single memory (fact) with its evidence by id.',
    parameters: getMemoryArgs as unknown as Record<string, unknown>,
    async execute(rawArgs) {
      const args = getMemoryArgs.parse(rawArgs)
      const found = await client.get(args.id)
      if (!found) {
        return { found: false as const, id: args.id }
      }
      return { found: true as const, fact: found.fact, evidence: found.evidence }
    },
  }

  const forget_memory: ToolDefinition = {
    name: 'forget_memory',
    description:
      'Permanently delete memories by selector (fact/entity/episode id, scope, or ' +
      'date range) for privacy. This is destructive. A single `factId` is a targeted ' +
      'delete; ANY broader selector (entity/episode/scope/date range) is a bulk delete ' +
      'and requires `confirm: true`.',
    parameters: forgetArgs as unknown as Record<string, unknown>,
    async execute(rawArgs) {
      const args = forgetArgs.parse(rawArgs)
      // Mirror the CLI gate (plan §18.2): a bare `factId` is targeted; anything
      // broader is a destructive bulk delete and requires explicit confirmation
      // so a model call cannot silently purge an entire scope or date range.
      const isSingleId =
        args.factId !== undefined &&
        args.entityId === undefined &&
        args.episodeId === undefined &&
        args.scope === undefined &&
        args.before === undefined &&
        args.after === undefined
      if (!isSingleId && args.confirm !== true) {
        throw new Error('forget_memory: bulk delete requires confirm: true')
      }
      const result = await client.forget({
        ...(args.factId !== undefined ? { factId: args.factId } : {}),
        ...(args.entityId !== undefined ? { entityId: args.entityId } : {}),
        ...(args.episodeId !== undefined ? { episodeId: args.episodeId } : {}),
        ...(args.scope !== undefined ? { scope: toSelector(args.scope) } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
        ...(args.after !== undefined ? { after: args.after } : {}),
      })
      return { deleted: result.deleted }
    },
  }

  const build_memory_context: ToolDefinition = {
    name: 'build_memory_context',
    description:
      'Build a token-bounded prompt context block of the most relevant memories for ' +
      'a query/task within the current scope set.',
    parameters: buildContextArgs as unknown as Record<string, unknown>,
    async execute(rawArgs, toolCtx) {
      const args = buildContextArgs.parse(rawArgs)
      const resolved = resolveScopes(scopeInputFor(toolCtx))
      const scopes = args.scope ? [toSelector(args.scope)] : readScopeSet(resolved)
      if (!args.global) {
        await ensureReadScopes(client, scopes)
      }
      const result = await client.buildContext({
        query: args.query,
        // Bound a `global` read to the resolved user (plan §9.1; shared-DB leak).
        ...(args.global ? { global: true, globalUser: resolved.user.key } : { scopes }),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
        ...(args.includeHistory ? { includeHistory: true } : {}),
      })
      return result
    },
  }

  const list_entities: ToolDefinition = {
    name: 'list_entities',
    description: 'List known entities (people, repos, tools, concepts) in a scope.',
    parameters: listEntitiesArgs as unknown as Record<string, unknown>,
    async execute(rawArgs, toolCtx) {
      const args = listEntitiesArgs.parse(rawArgs)
      const resolved = resolveScopes(scopeInputFor(toolCtx))
      const scope: ScopeSelector = args.scope
        ? toSelector(args.scope)
        : toSelector(resolved.project)
      if (scope.type !== 'global') {
        await client.ensureScope(scope.type as WritableScopeSelector['type'], scope.key)
      }
      const entities = await client.listEntities(scope)
      return { entities, count: entities.length, scope: `${scope.type}:${scope.key}` }
    },
  }

  const memory_status: ToolDefinition = {
    name: 'memory_status',
    description:
      'Report Naru memory status: DB path, counts, retention mode, provider ' +
      'features, and how the adapter reached the store (embedded vs server).',
    parameters: statusArgs as unknown as Record<string, unknown>,
    async execute(rawArgs) {
      statusArgs.parse(rawArgs ?? {})
      const status = await client.status()
      return status
    },
  }

  return [
    add_memory,
    search_memories,
    get_memories,
    get_memory,
    forget_memory,
    build_memory_context,
    list_entities,
    memory_status,
  ]
}

/** The ordered native tool names (plan §17.3), exported for the installer/tests. */
export const NATIVE_TOOL_NAMES = [
  'add_memory',
  'search_memories',
  'get_memories',
  'get_memory',
  'forget_memory',
  'build_memory_context',
  'list_entities',
  'memory_status',
] as const

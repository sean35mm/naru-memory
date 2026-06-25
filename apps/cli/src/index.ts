import { userInfo } from 'node:os'
import { basename } from 'node:path'
import {
  type AddManualInput,
  type CaptureAndExtractInput,
  type EmbeddingProvider,
  type EmbeddingsConfig,
  type ForgetSelector,
  type LlmConfig,
  type LlmProvider,
  Naru,
  type NaruOpenOptions,
  type WritableScopeSelector,
  resolveConfig,
} from '@naru/core'
// Import the installer from its dedicated subpath (NOT the package barrel): the
// barrel re-exports the OpenCode plugin, which statically imports
// `@opencode-ai/plugin` (an OPTIONAL peer). Pulling that into the CLI bundle
// makes `naru` crash for normal users who don't have OpenCode installed.
import {
  type InstallerResult,
  install as installAdapter,
  uninstall as uninstallAdapter,
} from '@naru/opencode-adapter/installer'
import type { FactStatus, ScopeType } from '@naru/schema'
import { FACT_STATUSES, SCOPE_TYPES } from '@naru/schema'
import { createServer, readServerFile, serverFilePath } from '@naru/server'
import { Command } from 'commander'
import type { MemoryClient } from './client'
import { acquireLock } from './lock'
import { type OutputContext, describeError, emitError, emitSuccess } from './output'
import { resolveClient } from './resolve'

/** Selector parsed from a `type:key` scope string (plan §16 `--scope`). */
interface ParsedScope {
  type: ScopeType
  key: string
}

/** Global options shared by every command (plan §16). */
interface GlobalOptions {
  json?: boolean
  db?: string
  scope?: string[]
  global?: boolean
  /** LLM extractor provider (plan §6.2); `none` (default) disables extraction. */
  llmProvider?: string
  /** OpenAI-compatible base URL for the extractor (plan §6.2). */
  llmBaseUrl?: string
  /** Model id for the configured extractor provider. */
  llmModel?: string
  /** Embedder provider (plan §6.2, M3); `none` (default) disables vector retrieval. */
  embedProvider?: string
  /** OpenAI-compatible base URL for the embedder (plan §6.2). */
  embedBaseUrl?: string
  /** Model id for the configured embedder provider. */
  embedModel?: string
}

/** Provider identifiers accepted on `--llm-provider` (plan §6.2). */
const LLM_PROVIDERS: readonly LlmProvider[] = ['none', 'mock', 'openai-compat', 'ollama']

/** Provider identifiers accepted on `--embed-provider` (plan §6.2, M3). */
const EMBED_PROVIDERS: readonly EmbeddingProvider[] = ['none', 'mock', 'openai-compat', 'ollama']

/** Collect a repeatable option value into an array (commander reducer). */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/** OS username used for the default `user:` scope (plan §16 init). */
function osUsername(): string {
  try {
    const name = userInfo().username
    return name && name.length > 0 ? name : 'default'
  } catch {
    return 'default'
  }
}

/** Basename of the current working directory used for the default project scope. */
function projectKey(): string {
  return basename(process.cwd()) || 'default'
}

/**
 * Parse a `type:key` scope string into a typed selector.
 *
 * The key part may itself contain colons (e.g. a path), so only the first
 * colon is treated as the separator. Throws on an unknown/missing type.
 */
function parseScope(raw: string): ParsedScope {
  const idx = raw.indexOf(':')
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid --scope "${raw}": expected "type:key"`)
  }
  const type = raw.slice(0, idx)
  const key = raw.slice(idx + 1)
  if (!(SCOPE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`invalid scope type "${type}": expected one of ${SCOPE_TYPES.join(', ')}`)
  }
  return { type: type as ScopeType, key }
}

/** Parse all `--scope` selectors from global options (may be empty). */
function parseScopes(opts: GlobalOptions): ParsedScope[] {
  return (opts.scope ?? []).map(parseScope)
}

/**
 * Narrow a parsed scope to a WRITE target, rejecting `global` (plan §9.1, §9.2).
 *
 * `global` is a query-time read alias, never a stored scope row or write target.
 * A "global" write must resolve to `user`, not create a `global` row, so the
 * write commands refuse it here with a readable message rather than passing it
 * down to the (now type-narrowed, runtime-guarded) write path.
 */
function requireWritableScope(scope: ParsedScope): WritableScopeSelector {
  if (scope.type === 'global') {
    throw new Error(
      'cannot write to the "global" scope: it is a read alias; use --scope user:<key>',
    )
  }
  return { type: scope.type, key: scope.key }
}

/**
 * Resolve the optional LLM extractor config from flags, falling back to env
 * (plan §6.2). Precedence per field: `--llm-*` flag > `NARU_LLM_*` env. A
 * provider of `none` (or unset) returns `undefined` so extraction stays
 * unavailable and the manual path is the only ingestion route (plan §13.3).
 * `mock` is allowed for the offline demo/test backend. Throws on an unknown
 * provider so a typo surfaces as a readable error, not a silent no-op.
 */
function resolveLlmConfig(opts: GlobalOptions): LlmConfig | undefined {
  const rawProvider = opts.llmProvider ?? process.env.NARU_LLM_PROVIDER
  if (rawProvider === undefined || rawProvider === '' || rawProvider === 'none') {
    return undefined
  }
  if (!(LLM_PROVIDERS as readonly string[]).includes(rawProvider)) {
    throw new Error(
      `invalid --llm-provider "${rawProvider}": expected one of ${LLM_PROVIDERS.join(', ')}`,
    )
  }
  const baseUrl = opts.llmBaseUrl ?? process.env.NARU_LLM_BASE_URL
  const model = opts.llmModel ?? process.env.NARU_LLM_MODEL
  const apiKey = process.env.NARU_LLM_API_KEY
  const config: LlmConfig = { provider: rawProvider as LlmProvider }
  if (baseUrl !== undefined && baseUrl !== '') {
    config.baseUrl = baseUrl
  }
  if (model !== undefined && model !== '') {
    config.model = model
  }
  if (apiKey !== undefined && apiKey !== '') {
    config.apiKey = apiKey
  }
  return config
}

/**
 * Resolve the optional embedder config from flags, falling back to env (plan
 * §6.2, M3). Precedence per field: `--embed-*` flag > `NARU_EMBED_*` env. A
 * provider of `none` (or unset) returns `undefined` so vector retrieval stays
 * OFF and search degrades to BM25/entity/recency (plan §6.2). `mock` is the
 * deterministic offline/test backend (no network). Throws on an unknown provider
 * so a typo surfaces as a readable error, not a silent no-op.
 */
function resolveEmbeddingsConfig(opts: GlobalOptions): EmbeddingsConfig | undefined {
  const rawProvider = opts.embedProvider ?? process.env.NARU_EMBED_PROVIDER
  if (rawProvider === undefined || rawProvider === '' || rawProvider === 'none') {
    return undefined
  }
  if (!(EMBED_PROVIDERS as readonly string[]).includes(rawProvider)) {
    throw new Error(
      `invalid --embed-provider "${rawProvider}": expected one of ${EMBED_PROVIDERS.join(', ')}`,
    )
  }
  const baseUrl = opts.embedBaseUrl ?? process.env.NARU_EMBED_BASE_URL
  const model = opts.embedModel ?? process.env.NARU_EMBED_MODEL
  const apiKey = process.env.NARU_EMBED_API_KEY
  const config: EmbeddingsConfig = { provider: rawProvider as EmbeddingProvider }
  if (baseUrl !== undefined && baseUrl !== '') {
    config.baseUrl = baseUrl
  }
  if (model !== undefined && model !== '') {
    config.model = model
  }
  if (apiKey !== undefined && apiKey !== '') {
    config.apiKey = apiKey
  }
  return config
}

/**
 * Resolve {@link NaruOpenOptions} from global flags: DB path (`--db` > `NARU_DB`
 * > default, plan §23) plus the optional LLM extractor (plan §6.2) and embedder
 * (plan §6.2, M3) configs. All flow into `Naru.open` for embedded mode and
 * `resolveClient`'s transport pick.
 */
function resolveOpenOptions(opts: GlobalOptions): NaruOpenOptions {
  const db = opts.db ?? process.env.NARU_DB
  const llm = resolveLlmConfig(opts)
  const embeddings = resolveEmbeddingsConfig(opts)
  return {
    ...(db ? { db } : {}),
    ...(llm ? { llm } : {}),
    ...(embeddings ? { embeddings } : {}),
  }
}

/**
 * Run a command body with a resolved {@link MemoryClient}, always releasing it
 * and translating thrown errors into the correct output (plan §16): a JSON
 * error envelope in `--json` mode, otherwise a readable stderr message + exit 1.
 *
 * The client is chosen per the §12.3 write-coordination rule: it proxies to a
 * live local server when one owns the resolved DB, else operates the DB
 * embedded (writes guarded by the file lock). Command bodies are transport
 * agnostic — they only see the {@link MemoryClient} interface.
 */
async function withClient(
  ctx: OutputContext,
  opts: GlobalOptions,
  body: (client: MemoryClient) => Promise<void>,
): Promise<void> {
  let client: MemoryClient | undefined
  try {
    client = resolveClient(resolveOpenOptions(opts))
    await body(client)
  } catch (error) {
    const { code, message } = describeError(error)
    emitError(ctx, code, message)
  } finally {
    await client?.close()
  }
}

/**
 * Run an M5 admin operation (export/import/doctor/backup, plan §16/§19/§20/§22)
 * against the embedded {@link Naru} facade, honoring the §12.3 write-coordination
 * rule.
 *
 * These ops are NOT part of the {@link MemoryClient} interface and the local
 * server exposes no tRPC route for them, so — unlike {@link withClient} — they
 * never proxy: they operate the DB directly. Coordination depends on the op:
 *
 * - READ ops (`write: false` — export/doctor/backup) take no lock and may run
 *   even while a live server owns the DB: WAL permits concurrent readers and
 *   `VACUUM INTO`/`PRAGMA` checks never mutate the live DB (plan §12.3 reads).
 *
 * - WRITE ops (`write: true` — import/doctor --repair) are admin writes. If a
 *   LIVE server already owns this DB there is no admin proxy to forward to, so
 *   we REFUSE with operator guidance rather than open a second writer. Otherwise
 *   we take the same embedded write lock the normal write path uses and inject an
 *   {@link NaruOpenOptions.adminWriteGuard} that re-checks the discovery file
 *   UNDER THE LOCK — covering the startup race where a server is published after
 *   we resolved but before the write runs (mirrors {@link EmbeddedClient.write}).
 *
 * Thrown errors become a JSON error envelope (`--json`) or a readable stderr
 * line + exit 1, matching every other command (plan §16).
 */
async function withAdminNaru(
  ctx: OutputContext,
  opts: GlobalOptions,
  config: { write: boolean },
  body: (naru: Naru) => Promise<void> | void,
): Promise<void> {
  const open = resolveOpenOptions(opts)
  const { dbPath } = resolveConfig(open.db !== undefined ? { db: open.db } : {})

  // A live server is the single logical writer (§12.3). Admin writes cannot be
  // proxied to it (no route), so refuse up-front with guidance.
  if (config.write) {
    const server = readServerFile(dbPath)
    if (server) {
      emitError(
        ctx,
        'server_running',
        `a live Naru server owns this DB (pid ${server.pid} at ${server.host}:${server.port}); admin writes (import/repair) cannot be proxied — stop the server, then retry`,
      )
      return
    }
  }

  const lock = config.write ? acquireLock(dbPath) : undefined
  let naru: Naru | undefined
  try {
    naru = Naru.open({
      ...open,
      // READ ops open the store READ-ONLY (plan §12.3): no second writer-capable
      // connection, no migration writes. A missing/behind-schema DB fails fast
      // with guidance instead of being silently created/migrated behind a live
      // server. WRITE ops keep the writable connection (the embedded write lock).
      readonly: !config.write,
      // Re-check the discovery file under the lock; if a server appeared after
      // we resolved, refuse the admin write instead of running a second writer.
      ...(config.write
        ? {
            adminWriteGuard: (): void => {
              const server = readServerFile(dbPath)
              if (server) {
                throw new Error(
                  `a live Naru server owns this DB (pid ${server.pid} at ${server.host}:${server.port}); admin writes (import/repair) cannot be proxied — stop the server, then retry`,
                )
              }
            },
          }
        : {}),
    })
    await body(naru)
  } catch (error) {
    const { code, message } = describeError(error)
    emitError(ctx, code, message)
  } finally {
    naru?.close()
    lock?.release()
  }
}

/** Read merged global options off the resolved commander command. */
function globalsOf(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions
}

/**
 * Attach the global options to a command (plan §16).
 *
 * Registered on every subcommand (not just the root) so they may appear after
 * the subcommand and its positional/variadic arguments — commander stops a
 * variadic at the first `--option` and then parses these. `optsWithGlobals()`
 * still merges any that were supplied before the subcommand.
 */
function withGlobalOptions(command: Command): Command {
  return command
    .option('--json', 'emit a single-line JSON envelope (no colors/spinners)')
    .option('--db <path>', 'override the canonical SQLite DB path')
    .option('--scope <type:key>', 'scope selector (repeatable, e.g. user:alice)', collect)
    .option('--global', 'expand the read set across project + user scopes')
    .option(
      '--llm-provider <provider>',
      `extractor provider (one of ${LLM_PROVIDERS.join(', ')}; default: none)`,
    )
    .option('--llm-base-url <url>', 'OpenAI-compatible base URL for the extractor')
    .option('--llm-model <model>', 'model id for the configured extractor provider')
    .option(
      '--embed-provider <provider>',
      `embedder provider (one of ${EMBED_PROVIDERS.join(', ')}; default: none)`,
    )
    .option('--embed-base-url <url>', 'OpenAI-compatible base URL for the embedder')
    .option('--embed-model <model>', 'model id for the configured embedder provider')
}

/** Build the commander program (plan §16). */
function buildProgram(ctx: OutputContext): Command {
  const program = new Command()
  // Set the override BEFORE any subcommand is created so every subcommand
  // inherits it (commander only propagates exitOverride to children created
  // after it is set). Otherwise a subcommand's own arg/option validation
  // failure calls process.exit() directly, bypassing main()'s catch and the
  // JSON error envelope (plan §16).
  program.exitOverride()

  withGlobalOptions(
    program.name('naru').description('Naru Memory — local-first memory for AI agents'),
  )

  // naru init -------------------------------------------------------------
  withGlobalOptions(program.command('init'))
    .description('initialize the local DB + default scopes, then print status')
    .action(async (_o, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const user = await client.ensureScope('user', osUsername())
        const project = await client.ensureScope('project', projectKey())
        const status = await client.status()
        emitSuccess(
          ctx,
          { status, scopes: [user.key, project.key] },
          {
            human: [
              `initialized ${status.dbPath}`,
              `scopes: ${user.key}, ${project.key}`,
              `facts=${status.counts.facts} entities=${status.counts.entities} episodes=${status.counts.episodes} scopes=${status.counts.scopes}`,
              `retention=${status.retentionMode}`,
            ],
          },
        )
      })
    })

  // naru add <text...> ----------------------------------------------------
  withGlobalOptions(program.command('add'))
    .description('add a manual memory (infer=false)')
    .argument('<text...>', 'memory text')
    .option('--subject <subject>', 'triple subject')
    .option('--predicate <predicate>', 'triple predicate')
    .option('--object <object>', 'triple object')
    .option('--confidence <confidence>', 'confidence in [0,1]')
    .option('--source-type <sourceType>', 'source type (default: manual)')
    .action(async (textParts: string[], cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const scopes = parseScopes(opts)
        const parsed = scopes[0] ?? { type: 'project' as ScopeType, key: projectKey() }
        const scope = requireWritableScope(parsed)
        const confidence = cmdOpts.confidence !== undefined ? Number(cmdOpts.confidence) : undefined
        if (confidence !== undefined && Number.isNaN(confidence)) {
          throw new Error(`invalid --confidence "${cmdOpts.confidence}": expected a number`)
        }
        const input: AddManualInput = {
          text: textParts.join(' '),
          scope,
          ...(cmdOpts.subject !== undefined ? { subject: cmdOpts.subject } : {}),
          ...(cmdOpts.predicate !== undefined ? { predicate: cmdOpts.predicate } : {}),
          ...(cmdOpts.object !== undefined ? { object: cmdOpts.object } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(cmdOpts.sourceType !== undefined ? { sourceType: cmdOpts.sourceType } : {}),
        }
        const fact = await client.addMemory(input)
        const scopeKey = `${scope.type}:${scope.key}`
        emitSuccess(
          ctx,
          { fact },
          {
            scope: scopeKey,
            human: [
              `added ${fact.id}`,
              `  ${fact.statement}`,
              `  scope=${scopeKey} status=${fact.status}`,
            ],
          },
        )
      })
    })

  // naru capture <text...> ------------------------------------------------
  withGlobalOptions(program.command('capture'))
    .description('capture an episode and extract memories (infer=true)')
    .argument('<text...>', 'episode text')
    .option('--source-type <sourceType>', 'source type (default: chat)')
    .option('--source-ref <ref>', 'opaque source reference (redacted before persist)')
    .option('--observed-at <iso>', 'observation timestamp (ISO 8601)')
    .action(async (textParts: string[], cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const scopes = parseScopes(opts)
        const parsed = scopes[0] ?? { type: 'project' as ScopeType, key: projectKey() }
        const scope = requireWritableScope(parsed)
        const input: CaptureAndExtractInput = {
          text: textParts.join(' '),
          scope,
          ...(cmdOpts.sourceType !== undefined ? { sourceType: cmdOpts.sourceType } : {}),
          ...(cmdOpts.sourceRef !== undefined ? { sourceRef: cmdOpts.sourceRef } : {}),
          ...(cmdOpts.observedAt !== undefined ? { observedAt: cmdOpts.observedAt } : {}),
        }
        const result = await client.capture(input)
        const scopeKey = `${scope.type}:${scope.key}`
        emitSuccess(
          ctx,
          { episode: result.episode, facts: result.facts },
          {
            scope: scopeKey,
            count: result.facts.length,
            human: [
              `captured ${result.episode.id} (${result.facts.length} fact(s))`,
              `  scope=${scopeKey}`,
              ...result.facts.map((f) => `  ${f.id}  [${f.status}] ${f.statement}`),
            ],
          },
        )
      })
    })

  // naru search <query...> ------------------------------------------------
  withGlobalOptions(program.command('search'))
    .description('search memories within the resolved scope set')
    .argument('<query...>', 'search query')
    .option('--limit <n>', 'maximum results')
    .option('--history', 'include superseded facts / history')
    .action(async (queryParts: string[], cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const scopes = parseScopes(opts)
        const limit = cmdOpts.limit !== undefined ? Number(cmdOpts.limit) : undefined
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new Error(`invalid --limit "${cmdOpts.limit}": expected a positive integer`)
        }
        const results = await client.search({
          query: queryParts.join(' '),
          ...(scopes.length > 0 ? { scopes } : {}),
          ...(opts.global ? { global: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cmdOpts.history ? { includeHistory: true } : {}),
        })
        emitSuccess(
          ctx,
          { results },
          {
            count: results.length,
            human:
              results.length === 0
                ? ['no results']
                : results.map(
                    (r) => `${r.score.toFixed(3)}  [${r.scope}] ${r.statement}  (${r.factId})`,
                  ),
          },
        )
      })
    })

  // naru context <query...> -----------------------------------------------
  withGlobalOptions(program.command('context'))
    .description('build a token-bounded prompt context for a query (plan §14.4)')
    .argument('<query...>', 'context query / task')
    .option('--limit <n>', 'maximum candidate facts to consider')
    .option('--token-budget <n>', 'token budget the prompt block must not exceed (default 1024)')
    .option('--history', 'include superseded facts / history')
    .action(async (queryParts: string[], cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const scopes = parseScopes(opts)
        const limit = cmdOpts.limit !== undefined ? Number(cmdOpts.limit) : undefined
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new Error(`invalid --limit "${cmdOpts.limit}": expected a positive integer`)
        }
        const tokenBudget =
          cmdOpts.tokenBudget !== undefined ? Number(cmdOpts.tokenBudget) : undefined
        if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
          throw new Error(
            `invalid --token-budget "${cmdOpts.tokenBudget}": expected a positive integer`,
          )
        }
        const result = await client.buildContext({
          query: queryParts.join(' '),
          ...(scopes.length > 0 ? { scopes } : {}),
          ...(opts.global ? { global: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(tokenBudget !== undefined ? { tokenBudget } : {}),
          ...(cmdOpts.history ? { includeHistory: true } : {}),
        })
        emitSuccess(ctx, result, {
          count: result.items.length,
          human: [
            `context: ${result.items.length} item(s), ~${result.tokenEstimate} token(s)`,
            ...(result.promptBlock.length > 0 ? ['', result.promptBlock] : ['(empty)']),
          ],
        })
      })
    })

  // naru list -------------------------------------------------------------
  withGlobalOptions(program.command('list'))
    .description('list facts by scope/status')
    .option(
      '--status <status>',
      `fact status (default: active; one of ${FACT_STATUSES.join(', ')})`,
    )
    .option('--limit <n>', 'maximum results')
    .action(async (cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const scopes = parseScopes(opts)
        let status: FactStatus | undefined
        if (cmdOpts.status !== undefined) {
          if (!(FACT_STATUSES as readonly string[]).includes(cmdOpts.status)) {
            throw new Error(
              `invalid --status "${cmdOpts.status}": expected one of ${FACT_STATUSES.join(', ')}`,
            )
          }
          status = cmdOpts.status as FactStatus
        }
        const limit = cmdOpts.limit !== undefined ? Number(cmdOpts.limit) : undefined
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new Error(`invalid --limit "${cmdOpts.limit}": expected a positive integer`)
        }
        const facts = await client.list({
          ...(scopes[0] ? { scope: scopes[0] } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(limit !== undefined ? { limit } : {}),
        })
        emitSuccess(
          ctx,
          { facts },
          {
            count: facts.length,
            ...(scopes[0] ? { scope: `${scopes[0].type}:${scopes[0].key}` } : {}),
            human:
              facts.length === 0
                ? ['no facts']
                : facts.map((f) => `${f.id}  [${f.status}] ${f.statement}`),
          },
        )
      })
    })

  // naru get <id> ---------------------------------------------------------
  withGlobalOptions(program.command('get'))
    .description('get one fact with its evidence')
    .argument('<id>', 'fact id')
    .action(async (id: string, _o, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const found = await client.get(id)
        if (!found) {
          emitError(ctx, 'not_found', `fact not found: ${id}`)
          return
        }
        emitSuccess(ctx, found, {
          human: [
            `${found.fact.id}  [${found.fact.status}]`,
            `  ${found.fact.statement}`,
            `  predicate=${found.fact.predicate} confidence=${found.fact.confidence}`,
            `  evidence: ${found.evidence.length}`,
          ],
        })
      })
    })

  // naru forget -----------------------------------------------------------
  withGlobalOptions(program.command('forget'))
    .description('destructively delete facts/entities/episodes by selector')
    .option('--fact <id>', 'delete a single fact by id')
    .option('--entity <id>', 'delete facts referencing this entity')
    .option('--episode <id>', 'delete facts derived from this episode')
    .option('--before <iso>', 'delete facts observed before this ISO timestamp')
    .option('--after <iso>', 'delete facts observed after this ISO timestamp')
    .option('--yes', 'confirm a non-id (bulk) selector without prompting')
    .action(async (cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const scopes = parseScopes(opts)
        const selector: ForgetSelector = {
          ...(cmdOpts.fact !== undefined ? { factId: cmdOpts.fact } : {}),
          ...(cmdOpts.entity !== undefined ? { entityId: cmdOpts.entity } : {}),
          ...(cmdOpts.episode !== undefined ? { episodeId: cmdOpts.episode } : {}),
          ...(scopes[0] ? { scope: scopes[0] } : {}),
          ...(cmdOpts.before !== undefined ? { before: cmdOpts.before } : {}),
          ...(cmdOpts.after !== undefined ? { after: cmdOpts.after } : {}),
        }
        const hasSelector =
          selector.factId !== undefined ||
          selector.entityId !== undefined ||
          selector.episodeId !== undefined ||
          selector.scope !== undefined ||
          selector.before !== undefined ||
          selector.after !== undefined
        if (!hasSelector) {
          throw new Error('forget: at least one selector is required')
        }
        // A bare fact-id delete is targeted; broader selectors are destructive
        // and require explicit confirmation (plan §18.2).
        const isSingleId =
          selector.factId !== undefined &&
          selector.entityId === undefined &&
          selector.episodeId === undefined &&
          selector.scope === undefined &&
          selector.before === undefined &&
          selector.after === undefined
        if (!isSingleId && !cmdOpts.yes) {
          throw new Error('forget: bulk delete requires --yes to confirm')
        }
        const result = await client.forget(selector)
        emitSuccess(ctx, result, {
          count: result.deleted,
          human: [`forgot ${result.deleted} fact(s)`],
        })
      })
    })

  // naru supersede <oldId> <newId> ---------------------------------------
  withGlobalOptions(program.command('supersede'))
    .description('manually supersede one fact with another')
    .argument('<oldId>', 'fact to supersede')
    .argument('<newId>', 'replacement fact')
    .option('--reason <reason>', 'reason for the supersession')
    .action(async (oldId: string, newId: string, cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const supersession = await client.supersede(
          oldId,
          newId,
          cmdOpts.reason as string | undefined,
        )
        emitSuccess(
          ctx,
          { supersession },
          {
            human: [`superseded ${oldId} -> ${newId}`, `  link=${supersession.id}`],
          },
        )
      })
    })

  // naru status -----------------------------------------------------------
  withGlobalOptions(program.command('status'))
    .description('show DB/index/provider/server status')
    .action(async (_o, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        const status = await client.status()
        const serverLine =
          status.server.mode === 'remote'
            ? `server: running ${status.server.url}`
            : 'server: embedded'
        const extractor = status.features.extractor
        const extractorLabel = extractor.available
          ? `${extractor.provider}${extractor.model ? `/${extractor.model}` : ''}`
          : 'unavailable'
        const vector = status.features.vector
        const vectorLabel = vector.embedder.available
          ? `${vector.backend}(${vector.embedder.provider}${vector.embedder.model ? `/${vector.embedder.model}` : ''})`
          : 'unavailable'
        emitSuccess(ctx, status, {
          human: [
            `db: ${status.dbPath}`,
            `facts=${status.counts.facts} entities=${status.counts.entities} episodes=${status.counts.episodes} scopes=${status.counts.scopes}`,
            `retention=${status.retentionMode}`,
            `features: extractor=${extractorLabel} vector=${vectorLabel} server=${status.features.server}`,
            serverLine,
          ],
        })
      })
    })

  // naru reindex ----------------------------------------------------------
  withGlobalOptions(program.command('reindex'))
    .description('rebuild derived FTS indexes from canonical rows')
    .action(async (_o, command: Command) => {
      const opts = globalsOf(command)
      await withClient(ctx, opts, async (client) => {
        await client.reindex()
        emitSuccess(ctx, { reindexed: true }, { human: ['reindexed'] })
      })
    })

  // naru export <file> ----------------------------------------------------
  // Write a portable bundle of CANONICAL tables only (plan §19): scopes,
  // episodes (per retention), entities, facts, evidence, edges, supersessions —
  // no derived FTS/vector/index_state rows. Read-only w.r.t. the DB, so it runs
  // embedded even behind a live server. A bundle is whole-store by design (plan
  // §19), so `--scope` is rejected rather than silently ignored.
  withGlobalOptions(program.command('export'))
    .description('write a portable memory bundle (canonical tables only, plan §19)')
    .argument('<file>', 'destination bundle file (JSON)')
    .action(async (file: string, _o, command: Command) => {
      const opts = globalsOf(command)
      if ((opts.scope ?? []).length > 0) {
        emitError(
          ctx,
          'error',
          'export does not support --scope: a bundle is a whole-store snapshot (plan §19)',
        )
        return
      }
      await withAdminNaru(ctx, opts, { write: false }, (naru) => {
        const bundle = naru.writeBundle(file)
        const counts = {
          scopes: bundle.scopes.length,
          episodes: bundle.episodes.length,
          entities: bundle.entities.length,
          facts: bundle.facts.length,
          evidence: bundle.evidence.length,
          edges: bundle.edges.length,
          supersessions: bundle.supersessions.length,
        }
        emitSuccess(
          ctx,
          {
            file,
            schemaVersion: bundle.schemaVersion,
            retentionMode: bundle.retentionMode,
            ...(bundle.embedding ? { embedding: bundle.embedding } : {}),
            counts,
          },
          {
            count: counts.facts,
            human: [
              `exported ${file}`,
              `  schema=${bundle.schemaVersion} retention=${bundle.retentionMode}`,
              `  scopes=${counts.scopes} episodes=${counts.episodes} entities=${counts.entities} facts=${counts.facts} evidence=${counts.evidence} edges=${counts.edges} supersessions=${counts.supersessions}`,
              ...(bundle.embedding
                ? [
                    `  embedding=${bundle.embedding.provider}/${bundle.embedding.model} (dim ${bundle.embedding.dimension})`,
                  ]
                : []),
            ],
          },
        )
      })
    })

  // naru import <file> ----------------------------------------------------
  // Import a portable bundle (plan §19). A WRITE: refuses (via withAdminNaru)
  // when a live server owns the DB. Dedupes by portable hashes, preserves ids
  // when safe, then rebuilds derived indexes (FTS always; vectors only when an
  // embedder is configured — else reembedNeeded carries the bundle provenance).
  withGlobalOptions(program.command('import'))
    .description('import a portable memory bundle, rebuilding derived indexes (plan §19)')
    .argument('<file>', 'source bundle file (JSON)')
    .action(async (file: string, _o, command: Command) => {
      const opts = globalsOf(command)
      await withAdminNaru(ctx, opts, { write: true }, async (naru) => {
        const result = await naru.importBundle(file)
        const total =
          result.imported.scopes +
          result.imported.episodes +
          result.imported.entities +
          result.imported.facts +
          result.imported.evidence +
          result.imported.edges +
          result.imported.supersessions
        emitSuccess(
          ctx,
          {
            imported: result.imported,
            skippedDuplicates: result.skippedDuplicates,
            remappedIds: result.remappedIds,
            skippedConflicts: result.skippedConflicts,
            ...(result.vectorsRebuilt ? { vectorsRebuilt: result.vectorsRebuilt } : {}),
            ...(result.embeddingMismatch ? { embeddingMismatch: result.embeddingMismatch } : {}),
            ...(result.reembedNeeded ? { reembedNeeded: result.reembedNeeded } : {}),
          },
          {
            count: total,
            human: [
              `imported ${file}`,
              `  rows=${total} (facts=${result.imported.facts} entities=${result.imported.entities} episodes=${result.imported.episodes} scopes=${result.imported.scopes} evidence=${result.imported.evidence} edges=${result.imported.edges} supersessions=${result.imported.supersessions})`,
              `  skippedDuplicates=${result.skippedDuplicates} remappedIds=${result.remappedIds} skippedConflicts=${result.skippedConflicts}`,
              ...(result.vectorsRebuilt
                ? [`  vectors: rebuilt ${result.vectorsRebuilt.embedded}`]
                : []),
              ...(result.embeddingMismatch
                ? [
                    '  WARNING: embedder mismatch — facts were re-embedded under a different model',
                    `    bundle embedding=${result.embeddingMismatch.bundleEmbedding.provider}/${result.embeddingMismatch.bundleEmbedding.model} (dim ${result.embeddingMismatch.bundleEmbedding.dimension})`,
                    `    re-embedded under=${result.embeddingMismatch.reembeddedUnder.provider}/${result.embeddingMismatch.reembeddedUnder.model} (dim ${result.embeddingMismatch.reembeddedUnder.dimension})`,
                  ]
                : []),
              ...(result.reembedNeeded
                ? [
                    `  vectors: re-embed needed — ${result.reembedNeeded.reason}`,
                    ...(result.reembedNeeded.embedding
                      ? [
                          `    bundle embedding=${result.reembedNeeded.embedding.provider}/${result.reembedNeeded.embedding.model} (dim ${result.reembedNeeded.embedding.dimension})`,
                        ]
                      : []),
                  ]
                : []),
            ],
          },
        )
      })
    })

  // naru doctor (alias: check) --------------------------------------------
  // Run integrity checks (plan §22): native PRAGMAs + logical orphan/drift
  // probes. Read-only and privacy-safe (ids/counts/kinds only, never text).
  // `--repair` is a WRITE (prunes orphans, rebuilds indexes) and refuses behind
  // a live server like `import`.
  withGlobalOptions(program.command('doctor'))
    .aliases(['check'])
    .description(
      'check DB integrity; --repair rebuilds derived indexes + prunes orphans (plan §22)',
    )
    .option('--repair', 'repair derived/orphan state from canonical rows (WRITE)')
    .action(async (cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      if (cmdOpts.repair) {
        await withAdminNaru(ctx, opts, { write: true }, async (naru) => {
          const result = await naru.repair()
          const prunedTotal =
            result.pruned.evidence +
            result.pruned.factVectors +
            result.pruned.edges +
            result.pruned.supersessions
          const rehomedTotal =
            result.rehomedByScope.facts +
            result.rehomedByScope.episodes +
            result.rehomedByScope.entities
          emitSuccess(
            ctx,
            {
              ok: result.report.ok,
              ftsRebuilt: result.ftsRebuilt,
              vectorsRebuilt: result.vectorsRebuilt,
              pruned: result.pruned,
              danglingEntityLinksCleared: result.danglingEntityLinksCleared,
              rehomedByScope: result.rehomedByScope,
              problems: result.report.problems.map((p) => ({ kind: p.kind, count: p.count })),
            },
            {
              count: prunedTotal + result.danglingEntityLinksCleared + rehomedTotal,
              human: [
                `repair: ${result.report.ok ? 'ok' : `${result.report.problems.length} problem(s) remain`}`,
                `  fts=${result.ftsRebuilt ? 'rebuilt' : 'unchanged'} vectors=${result.vectorsRebuilt ? `rebuilt ${result.vectorsRebuilt.embedded}` : 'none'}`,
                `  pruned: evidence=${result.pruned.evidence} factVectors=${result.pruned.factVectors} edges=${result.pruned.edges} supersessions=${result.pruned.supersessions} danglingLinks=${result.danglingEntityLinksCleared}`,
                `  rehomed (orphaned by missing scope): facts=${result.rehomedByScope.facts} episodes=${result.rehomedByScope.episodes} entities=${result.rehomedByScope.entities}`,
                ...result.report.problems.map((p) => `  - ${p.kind}: ${p.count}`),
              ],
            },
          )
        })
        return
      }
      await withAdminNaru(ctx, opts, { write: false }, (naru) => {
        const report = naru.checkIntegrity()
        emitSuccess(
          ctx,
          {
            ok: report.ok,
            problems: report.problems.map((p) => ({
              kind: p.kind,
              count: p.count,
              sampleIds: p.sampleIds,
            })),
          },
          {
            count: report.problems.length,
            human: report.ok
              ? ['integrity: ok']
              : [
                  `integrity: ${report.problems.length} problem(s)`,
                  ...report.problems.map((p) => `  - ${p.kind}: ${p.count}`),
                  'run `naru doctor --repair` to rebuild derived indexes and prune orphans',
                ],
          },
        )
      })
    })

  // naru backup <file> ----------------------------------------------------
  // VACUUM INTO snapshot (plan §20): a point-in-time, standalone .db (no WAL/SHM)
  // chmod'd 0600, with its canonical counts verified against the source.
  // Read-only w.r.t. the live DB, so it runs even behind a live server.
  withGlobalOptions(program.command('backup'))
    .description('write a safe VACUUM INTO snapshot of the canonical DB (plan §20)')
    .argument('<file>', 'destination snapshot file (.db)')
    .action(async (file: string, _o, command: Command) => {
      const opts = globalsOf(command)
      await withAdminNaru(ctx, opts, { write: false }, (naru) => {
        const result = naru.backupTo(file)
        emitSuccess(
          ctx,
          {
            path: result.path,
            bytes: result.bytes,
            verified: result.verified,
            counts: result.counts,
          },
          {
            count: result.counts.facts,
            human: [
              `backed up ${result.path}`,
              `  bytes=${result.bytes} verified=${result.verified}`,
              `  facts=${result.counts.facts} entities=${result.counts.entities} episodes=${result.counts.episodes} scopes=${result.counts.scopes}`,
            ],
          },
        )
      })
    })

  // naru opencode install|uninstall --------------------------------------
  // The OpenCode adapter installer (plan §16, §17.6) only edits OpenCode's
  // config file — it opens no DB — so these commands call the installer
  // directly instead of `withClient`. `--config-dir` overrides the managed
  // dir (tests pass a temp dir; never a real ~/.config) and `--dry-run`
  // computes the plan without writing. The registered plugin specifier is its
  // own ownership marker, so uninstall removes only that exact entry and MCP
  // is never enabled (§17.2/§17.6).
  const opencode = withGlobalOptions(program.command('opencode')).description(
    'manage the OpenCode adapter integration (plan §17.6)',
  )

  withGlobalOptions(opencode.command('install'))
    .description('register the Naru plugin specifier in OpenCode config (no MCP)')
    .option('--config-dir <path>', 'OpenCode config dir to manage (default: user config dir)')
    .option('--project-dir <path>', 'project dir to associate (reserved; recorded only)')
    .option('--dry-run', 'compute the planned changes without writing')
    .action(async (cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      runOpencode(ctx, opts, () =>
        installAdapter({
          ...(cmdOpts.configDir !== undefined ? { configDir: cmdOpts.configDir } : {}),
          ...(cmdOpts.projectDir !== undefined ? { projectDir: cmdOpts.projectDir } : {}),
          ...(cmdOpts.dryRun ? { dryRun: true } : {}),
        }),
      )
    })

  withGlobalOptions(opencode.command('uninstall'))
    .description('remove only the Naru plugin specifier from OpenCode config')
    .option('--config-dir <path>', 'OpenCode config dir to manage (default: user config dir)')
    .option('--dry-run', 'compute the planned changes without writing')
    .action(async (cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      runOpencode(ctx, opts, () =>
        uninstallAdapter({
          ...(cmdOpts.configDir !== undefined ? { configDir: cmdOpts.configDir } : {}),
          ...(cmdOpts.dryRun ? { dryRun: true } : {}),
        }),
      )
    })

  // naru serve ------------------------------------------------------------
  withGlobalOptions(program.command('serve'))
    .description('start the local tRPC server (single logical writer) until Ctrl-C')
    .option('--host <host>', 'bind host (default: 127.0.0.1)')
    .option('--port <n>', 'bind port (default: ephemeral)')
    .action(async (cmdOpts, command: Command) => {
      const opts = globalsOf(command)
      await runServe(ctx, opts, cmdOpts)
    })

  return program
}

/**
 * `naru opencode install|uninstall` (plan §16, §17.6): run the OpenCode adapter
 * installer body and emit its {@link InstallerResult} in the right shape — a
 * JSON envelope in `--json` mode, otherwise readable lines describing the plan
 * or applied changes. The installer never opens the DB, so this does not use
 * `withClient`; a thrown error (e.g. malformed user config it refuses to
 * overwrite) becomes a JSON error envelope or a readable stderr line + exit 1.
 */
function runOpencode(ctx: OutputContext, _opts: GlobalOptions, body: () => InstallerResult): void {
  try {
    const result = body()
    const verb = result.dryRun ? 'planned' : result.changed ? 'applied' : 'no changes'
    emitSuccess(ctx, result, {
      count: result.changes.length,
      human: [
        `opencode adapter: ${verb}`,
        `  config: ${result.configPath}`,
        ...(result.changes.length === 0
          ? ['  (already in the desired state)']
          : result.changes.map((c) => `  - ${c.detail}`)),
      ],
    })
  } catch (error) {
    const { code, message } = describeError(error)
    emitError(ctx, code, message)
  }
}

/**
 * `naru serve` (plan §12.3, §16): start the secured local server on the
 * resolved DB and stay up until a termination signal. Prints the bound URL and
 * discovery-file path — never the token (it lives only in the `0600` file).
 *
 * Resolves the SAME DB path as every other command so the discovery file lands
 * where clients look. Refuses (via {@link createServer}) to start a second
 * server for a DB already owned by a live one. On `--json`, emits one success
 * envelope describing the listener; in human mode prints readable lines. The
 * promise resolves only once the server has shut down (graceful Ctrl-C).
 */
async function runServe(
  ctx: OutputContext,
  opts: GlobalOptions,
  cmdOpts: { host?: string; port?: string },
): Promise<void> {
  const open = resolveOpenOptions(opts)
  const { dbPath } = resolveConfig(open.db !== undefined ? { db: open.db } : {})

  // Surface a clear error if a live server already owns this DB.
  const existing = readServerFile(dbPath)
  if (existing) {
    emitError(
      ctx,
      'server_running',
      `a live Naru server already owns this DB (pid ${existing.pid} at ${existing.host}:${existing.port})`,
    )
    return
  }

  let port: number | undefined
  if (cmdOpts.port !== undefined) {
    const n = Number.parseInt(cmdOpts.port, 10)
    if (!Number.isInteger(n) || n < 0) {
      emitError(ctx, 'error', `invalid --port "${cmdOpts.port}": expected a non-negative integer`)
      return
    }
    port = n
  }

  let handle: Awaited<ReturnType<typeof createServer>>
  try {
    handle = await createServer({
      ...(open.db !== undefined ? { db: open.db } : {}),
      ...(open.llm !== undefined ? { llm: open.llm } : {}),
      ...(open.embeddings !== undefined ? { embeddings: open.embeddings } : {}),
      ...(cmdOpts.host !== undefined ? { host: cmdOpts.host } : {}),
      ...(port !== undefined ? { port } : {}),
    })
  } catch (error) {
    const { code, message } = describeError(error)
    emitError(ctx, code, message)
    return
  }

  const discoveryPath = serverFilePath(dbPath)
  emitSuccess(
    ctx,
    { url: handle.url, host: handle.host, port: handle.port, discoveryFile: discoveryPath },
    {
      human: [
        `naru server listening on ${handle.url}`,
        `discovery file: ${discoveryPath}`,
        'press Ctrl-C to stop',
      ],
    },
  )

  // Stay up until a termination signal, then shut down gracefully.
  await new Promise<void>((resolve) => {
    let shuttingDown = false
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        return
      }
      shuttingDown = true
      if (!ctx.json) {
        process.stderr.write(`\n${signal} received, shutting down\n`)
      }
      handle
        .close()
        .then(() => resolve())
        .catch((err: unknown) => {
          if (!ctx.json) {
            process.stderr.write(`shutdown error: ${String(err)}\n`)
          }
          resolve()
        })
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
  })
}

/**
 * CLI entrypoint (plan §16). Resolves `--json` early so even argv-parse errors
 * surface as the right shape, then routes to a command. All command bodies are
 * wrapped so failures become a JSON error envelope or a readable stderr line.
 */
export async function main(argv: string[]): Promise<void> {
  const ctx: OutputContext = {
    json: argv.includes('--json'),
    startedAt: Date.now(),
  }
  const program = buildProgram(ctx)
  program.configureOutput({
    writeErr: (str) => {
      if (!ctx.json) {
        process.stderr.write(str)
      }
    },
  })
  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (error) {
    // commander throws for parse errors and for --help/--version (which exit 0).
    const commanderError = error as { exitCode?: number; code?: string }
    if (
      commanderError.code === 'commander.helpDisplayed' ||
      commanderError.code === 'commander.version' ||
      commanderError.exitCode === 0
    ) {
      return
    }
    const { code, message } = describeError(error)
    emitError(ctx, code, message)
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`fatal: ${String(error)}\n`)
  process.exitCode = 1
})

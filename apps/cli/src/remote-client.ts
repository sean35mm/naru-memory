import type { AppRouter } from '@naru/api'
import type {
  AddManualInput,
  BuildContextInput,
  BuildContextResult,
  CaptureAndExtractInput,
  CaptureResult,
  EntityWithFacts,
  FactWithEvidence,
  ForgetSelector,
  HistoryEntry,
  ListInput,
  ScopeSelector,
  SearchInput,
  WritableScopeSelector,
} from '@naru/core'
import type { Entity, Episode, Fact, Scope, SearchResultItem, Supersession } from '@naru/schema'
import type { ServerFile } from '@naru/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { ClientStatus, MemoryClient } from './client'

/** Typed vanilla tRPC client bound to the discovered server (plan §15). */
type TrpcClient = ReturnType<typeof createTRPCClient<AppRouter>>

/**
 * Build a typed tRPC client for the discovered local server, attaching the
 * bearer token from its discovery file on every request (plan §15.3). Node 24
 * supplies a global `fetch`, so no fetch polyfill is needed.
 */
function buildTrpcClient(server: ServerFile): TrpcClient {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://${server.host}:${server.port}`,
        headers: { authorization: `Bearer ${server.token}` },
      }),
    ],
  })
}

/**
 * Remote client: proxies every operation to the running local server over the
 * typed tRPC transport (plan §12.3 single logical writer, §15). Writes land in
 * the server's serialized ingestion queue, so the §9 scope-safety and §18
 * redaction/forget invariants stay enforced on the core/server side and are
 * never re-implemented here. NOT_FOUND from `fact.get`/`entity.get` is mapped
 * back to `undefined` to match the embedded contract.
 */
export class RemoteClient implements MemoryClient {
  private readonly trpc: TrpcClient

  constructor(private readonly server: ServerFile) {
    this.trpc = buildTrpcClient(server)
  }

  ensureScope(type: ScopeSelector['type'], key: string, name?: string): Promise<Scope> {
    if (type === 'global') {
      // `global` is a query-time read alias, never a stored scope row or write
      // target (plan §9.1); the server's scope.resolve rejects it too.
      return Promise.reject(new Error('cannot resolve the "global" scope: it is a read alias only'))
    }
    return this.trpc.scope.resolve.mutate({ type, key, ...(name !== undefined ? { name } : {}) })
  }

  addMemory(input: AddManualInput): Promise<Fact> {
    return this.trpc.memory.add.mutate(input)
  }

  capture(input: CaptureAndExtractInput): Promise<CaptureResult> {
    // The server runs extraction inside its single-writer queue and resolves
    // only after the durable episode store + extraction commit (plan §12.3).
    return this.trpc.memory.capture.mutate(input)
  }

  search(input: SearchInput): Promise<SearchResultItem[]> {
    return this.trpc.memory.search.query(input)
  }

  buildContext(input: BuildContextInput): Promise<BuildContextResult> {
    // Proxies to the server's `context.build`, which runs the same hybrid
    // scope-safe search + token-budget packing (plan §14.4) inside core.
    return this.trpc.context.build.query(input)
  }

  list(input?: ListInput): Promise<Fact[]> {
    return this.trpc.memory.list.query(input)
  }

  async get(id: string): Promise<FactWithEvidence | undefined> {
    try {
      return await this.trpc.fact.get.query({ id })
    } catch (err) {
      if (isNotFound(err)) {
        return undefined
      }
      throw err
    }
  }

  listEntities(scope?: ScopeSelector): Promise<Entity[]> {
    return this.trpc.entity.list.query(scope !== undefined ? { scope } : undefined)
  }

  async getEntity(id: string): Promise<EntityWithFacts | undefined> {
    try {
      return await this.trpc.entity.get.query({ id })
    } catch (err) {
      if (isNotFound(err)) {
        return undefined
      }
      throw err
    }
  }

  forget(selector: ForgetSelector): Promise<{ deleted: number }> {
    return this.trpc.memory.forget.mutate(selector)
  }

  supersede(oldId: string, newId: string, reason?: string): Promise<Supersession> {
    return this.trpc.fact.supersede.mutate({
      oldId,
      newId,
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  history(factId: string): Promise<HistoryEntry[]> {
    return this.trpc.memory.history.query({ factId })
  }

  captureEpisode(input: {
    text: string
    scope: WritableScopeSelector
    sourceType: Episode['sourceType']
    sourceRef?: string | null
    observedAt?: string
  }): Promise<Episode> {
    return this.trpc.episode.capture.mutate(input)
  }

  async reindex(): Promise<void> {
    await this.trpc.index.rebuild.mutate()
  }

  async status(): Promise<ClientStatus> {
    const status = await this.trpc.system.status.query()
    return {
      ...status,
      server: { mode: 'remote', url: `http://${this.server.host}:${this.server.port}` },
    }
  }

  close(): Promise<void> {
    // The HTTP transport is stateless (no kept-open connection to release).
    return Promise.resolve()
  }
}

/** Whether a thrown tRPC client error carries a NOT_FOUND code. */
function isNotFound(err: unknown): boolean {
  const data = (err as { data?: { code?: string } }).data
  return data?.code === 'NOT_FOUND'
}

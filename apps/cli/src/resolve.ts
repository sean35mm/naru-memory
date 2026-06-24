import { Naru, type NaruOpenOptions, resolveConfig } from '@naru/core'
import { readServerFile } from '@naru/server'
import { EmbeddedClient, type MemoryClient } from './client'
import { RemoteClient } from './remote-client'

/**
 * Choose the transport for a command (plan §12.3 write coordination).
 *
 * Resolve the canonical DB path the SAME way the embedded store would (core's
 * {@link resolveConfig}, honoring `--db`/`NARU_DB`/default), then look for a
 * LIVE server owning that DB via its discovery file. A live server is the
 * single logical writer, so commands proxy to it ({@link RemoteClient}); a
 * stale/absent file means no owner, so we operate the DB directly
 * ({@link EmbeddedClient}). Reads and writes both follow this resolution; the
 * embedded write lock (§12.3) only matters when no server is present.
 */
export function resolveClient(options: NaruOpenOptions): MemoryClient {
  const { dbPath } = resolveConfig({
    ...(options.db !== undefined ? { db: options.db } : {}),
    ...(options.retentionMode !== undefined ? { retentionMode: options.retentionMode } : {}),
  })

  const server = readServerFile(dbPath)
  if (server) {
    return new RemoteClient(server)
  }

  const naru = Naru.open(options)
  return new EmbeddedClient(naru, dbPath)
}

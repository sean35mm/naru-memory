import { authedProcedure, router } from '../trpc'

/**
 * `system` router (plan §15.2): status / health.
 *
 * NOTE: `system.health` here is the authenticated tRPC health procedure. The
 * UNAUTHENTICATED HTTP `GET /health` (plan §15.3) is served by the server's
 * connect middleware, not here.
 */
export const systemRouter = router({
  /** DB path, counts, retention mode, capability seams -> `naru.status`. */
  status: authedProcedure.query(({ ctx }) => ctx.naru.status()),

  /** Basic health check (authenticated). */
  health: authedProcedure.query(() => ({ ok: true as const })),
})

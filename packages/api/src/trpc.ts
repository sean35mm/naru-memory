import type { Naru } from '@naru/core'
import { TRPCError, initTRPC } from '@trpc/server'

/**
 * Request context for the Naru tRPC API (plan §15).
 *
 * The router is STATELESS: the server owns the single {@link Naru} instance and
 * supplies it (plus the per-request auth decision) here. Procedures never open
 * their own store — they operate only through this injected facade, so the
 * scope-safety (§9), redaction, and forget invariants (§18) enforced inside the
 * core facade cannot be bypassed via the API.
 */
export interface NaruContext {
  naru: Naru
  /**
   * Whether the request carried a valid auth token. The HTTP layer decides this
   * (token check in `createContext`); the API layer only gates on the boolean
   * so the same router works under the in-process caller used by tests.
   */
  authed: boolean
}

const t = initTRPC.context<NaruContext>().create()

/** Root router builder. */
export const router = t.router
/** Factory for an in-process caller (tests + embedded use; no HTTP). */
export const createCallerFactory = t.createCallerFactory
/** Procedure with no auth requirement (used only by `system.health`). */
export const publicProcedure = t.procedure

/**
 * Procedure that requires a valid auth token (plan §15.3 — every request except
 * the unauthenticated HTTP `/health` requires the token). Throws UNAUTHORIZED
 * when the context was built without a valid token.
 */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.authed) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing or invalid auth token' })
  }
  return next()
})

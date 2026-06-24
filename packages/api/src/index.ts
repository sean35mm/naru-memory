/**
 * `@naru/api` — the typed tRPC product API (plan §15).
 *
 * STATELESS router: it receives a {@link NaruContext} (the single {@link Naru}
 * instance + the per-request auth decision) from the server. The CLI imports
 * {@link AppRouter} for end-to-end type safety against the local server.
 */
export { appRouter, type AppRouter } from './routers/app'
export {
  type NaruContext,
  authedProcedure,
  createCallerFactory,
  publicProcedure,
  router,
} from './trpc'

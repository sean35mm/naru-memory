import { router } from '../trpc'
import { contextRouter } from './context'
import { entityRouter } from './entity'
import { episodeRouter } from './episode'
import { factRouter } from './fact'
import { indexRouter } from './index'
import { memoryRouter } from './memory'
import { scopeRouter } from './scope'
import { systemRouter } from './system'

/**
 * Root tRPC router for the Naru product API (plan §15.1).
 *
 * Routers implemented for M2-B: memory, fact, episode, entity, scope, context,
 * index, system. Deferred to later milestones and intentionally NOT mounted:
 * `fact.neighborhood` (graph traversal) and the `profile.*` router (profile
 * synthesis) — both M3+ (plan §15.2). Their seams live in the plan, not here.
 */
export const appRouter = router({
  memory: memoryRouter,
  fact: factRouter,
  episode: episodeRouter,
  entity: entityRouter,
  scope: scopeRouter,
  context: contextRouter,
  index: indexRouter,
  system: systemRouter,
})

/** End-to-end-typesafe router type; imported by the server + CLI client. */
export type AppRouter = typeof appRouter

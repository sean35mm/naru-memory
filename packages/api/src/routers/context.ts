import { z } from 'zod'
import { ScopeSelectorSchema } from '../schemas'
import { authedProcedure, router } from '../trpc'

/**
 * `context.build` (plan §15.2, §14.4).
 *
 * Delegates to `naru.buildContext`, which runs the hybrid (lexical + entity +
 * vector when an embedder is configured) scope-safe search and then packs the
 * top-ranked items into a `promptBlock` within a token budget (default 1024,
 * estimated as ~ceil(chars/4)). The returned `tokenEstimate` never exceeds the
 * budget. Scope safety (§9.4) is enforced by the underlying search — the router
 * never bypasses it. Each item carries its per-signal `reason` (plan §14.4) so
 * ranking is inspectable; adapters inject `promptBlock`, tools inspect `items`.
 */
export const contextRouter = router({
  build: authedProcedure
    .input(
      z.object({
        query: z.string(),
        scope: ScopeSelectorSchema.optional(),
        scopes: z.array(ScopeSelectorSchema).optional(),
        global: z.boolean().optional(),
        globalUser: z.string().optional(),
        limit: z.number().int().positive().optional(),
        includeHistory: z.boolean().optional(),
        /** Token budget the assembled `promptBlock` must not exceed. */
        tokenBudget: z.number().int().positive().optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.naru.buildContext(input)),
})

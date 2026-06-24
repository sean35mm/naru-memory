import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { ScopeSelectorSchema, SourceTypeInput, WritableScopeSelectorSchema } from '../schemas'
import { authedProcedure, router } from '../trpc'

/**
 * `memory` router (plan §15.2): add / search / list / forget / history. Each
 * procedure maps onto the {@link Naru} facade so the §9 scope-safety and §18
 * redaction/forget invariants enforced in core are not bypassable here.
 */
export const memoryRouter = router({
  /** Add a manual memory (`infer=false`) -> `naru.addMemory` (plan §13.3). */
  add: authedProcedure
    .input(
      z.object({
        text: z.string().min(1),
        scope: WritableScopeSelectorSchema,
        subject: z.string().optional(),
        predicate: z.string().optional(),
        object: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        sourceType: SourceTypeInput.optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.naru.addMemory(input)),

  /**
   * Capture an episode and run extraction-driven ingestion (`infer=true`, plan
   * §13) -> `naru.capture`. Redacts first, stores the redacted episode, then
   * extracts/dedupes/supersedes via the configured provider; with no provider
   * (or on provider error) it falls back to a single manual fact and never
   * fails (plan §13.3). Routed through the server's single-writer queue (the
   * write methods allow-list in apps/server), so the episode is durably stored
   * and extraction completes inside the queue before this mutation resolves.
   * `global` is rejected at the transport boundary (writable scope, §9.2).
   */
  capture: authedProcedure
    .input(
      z.object({
        text: z.string().min(1),
        scope: WritableScopeSelectorSchema,
        sourceType: SourceTypeInput.optional(),
        sourceRef: z.string().nullable().optional(),
        observedAt: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.naru.capture(input)),

  /** Hybrid scoped search -> `naru.search` (plan §14, §9.4). */
  search: authedProcedure
    .input(
      z.object({
        query: z.string(),
        scope: ScopeSelectorSchema.optional(),
        scopes: z.array(ScopeSelectorSchema).optional(),
        global: z.boolean().optional(),
        globalUser: z.string().optional(),
        limit: z.number().int().positive().optional(),
        includeHistory: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => ctx.naru.search(input)),

  /** List facts by scope/status -> `naru.list` (plan §15.2). */
  list: authedProcedure
    .input(
      z
        .object({
          scope: ScopeSelectorSchema.optional(),
          status: z.enum(['active', 'superseded', 'deleted', 'rejected', 'archived']).optional(),
          limit: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.naru.list(input)),

  /** Destructive privacy purge by selector -> `naru.forget` (plan §18.2). */
  forget: authedProcedure
    .input(
      z
        .object({
          factId: z.string().optional(),
          entityId: z.string().optional(),
          episodeId: z.string().optional(),
          scope: ScopeSelectorSchema.optional(),
          before: z.string().optional(),
          after: z.string().optional(),
        })
        .refine(
          (s) =>
            s.factId != null ||
            s.entityId != null ||
            s.episodeId != null ||
            s.scope != null ||
            s.before != null ||
            s.after != null,
          { message: 'forget requires at least one selector' },
        ),
    )
    .mutation(({ ctx, input }) => {
      try {
        return ctx.naru.forget(input)
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : 'forget failed',
          cause: err,
        })
      }
    }),

  /** Supersession chain for a fact -> `naru.history` (plan §14.3). */
  history: authedProcedure
    .input(z.object({ factId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.naru.history(input.factId)),
})

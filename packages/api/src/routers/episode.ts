import { z } from 'zod'
import { SourceTypeInput, WritableScopeSelectorSchema } from '../schemas'
import { authedProcedure, router } from '../trpc'

/**
 * `episode` router (plan §15.2): capture raw source material.
 *
 * For M2 this captures-with-redaction only (no LLM extraction — that is M2-A,
 * plan §13.2). `sourceRef` is redacted before persist inside the core facade.
 */
export const episodeRouter = router({
  /** Capture a raw episode with redaction -> `naru.captureEpisode` (plan §13.1). */
  capture: authedProcedure
    .input(
      z.object({
        text: z.string().min(1),
        scope: WritableScopeSelectorSchema,
        sourceType: SourceTypeInput,
        sourceRef: z.string().nullable().optional(),
        observedAt: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.naru.captureEpisode(input)),
})

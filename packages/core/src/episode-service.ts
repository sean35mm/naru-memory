import {
  type Episode,
  type RetentionMode,
  type Scope,
  type SourceType,
  newEpisodeId,
  nowIso,
  sourceHash,
} from '@naru/schema'
import type { Store } from '@naru/store-sqlite'
import { redact } from './redaction'

/** Input for {@link EpisodeService.capture}. */
export interface CaptureEpisodeInput {
  text: string
  /** Owning scope (already ensured by the caller). */
  scope: Scope
  sourceType: SourceType
  sourceRef?: string | null
  observedAt?: string
  /** Retention mode for this episode; defaults to the service's mode. */
  retentionMode?: RetentionMode
}

/**
 * Episode capture with pre-persistence redaction (plan §13.1).
 *
 * Pipeline: redact FIRST (plan §10.2 — redact before persistence), compute the
 * portable `source_hash` over the redacted text, then dedupe by
 * `(scope_id, source_hash)` returning the existing episode if present. Under
 * `redacted` retention the redacted body is stored; under `minimal`/`none` the
 * body is dropped (plan §10.1).
 *
 * No LLM extraction runs in Milestone 1 (plan §13.3) — this is a clean seam.
 */
export class EpisodeService {
  constructor(
    private readonly store: Store,
    private readonly defaultRetention: RetentionMode,
  ) {}

  capture(input: CaptureEpisodeInput): Episode {
    const retentionMode = input.retentionMode ?? this.defaultRetention
    const { redacted } = redact(input.text)
    // Redact before persistence (plan §18.1/§10.2): a sourceRef can carry a
    // secret (token in a clone/webhook URL, presigned URL, Bearer callback).
    const sourceRef = input.sourceRef ? redact(input.sourceRef).redacted : null
    const hash = sourceHash({
      text: redacted,
      sourceType: input.sourceType,
      sourceRef,
    })

    const existing = this.store.episodes.getBySourceHash(input.scope.id, hash)
    if (existing) {
      return existing
    }

    const now = nowIso()
    const episode: Episode = {
      id: newEpisodeId(),
      scopeId: input.scope.id,
      sourceType: input.sourceType,
      sourceRef,
      sourceHash: hash,
      hmacHash: null,
      retentionMode,
      redactedText: retentionMode === 'redacted' ? redacted : null,
      metadata: {},
      observedAt: input.observedAt ?? now,
      createdAt: now,
    }
    return this.store.episodes.insert(episode)
  }
}

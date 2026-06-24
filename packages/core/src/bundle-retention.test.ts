import type { RetentionMode } from '@naru/schema'
import type { Store } from '@naru/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

/** Reach the embedded store for direct row inspection (test-only). */
function storeOf(naru: Naru): Store {
  return (naru as unknown as { store: Store }).store
}

/** Raw `evidence` rows as stored, for asserting the persisted columns directly. */
function rawEvidence(naru: Naru): { redacted_quote: string | null; quote_hash: string | null }[] {
  return storeOf(naru).db.prepare('SELECT redacted_quote, quote_hash FROM evidence').all() as {
    redacted_quote: string | null
    quote_hash: string | null
  }[]
}

describe('bundle retention honoring (plan §10.1/§19)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  for (const mode of ['minimal', 'none'] as RetentionMode[]) {
    it(`omits episode/evidence text but keeps facts under ${mode} retention`, () => {
      naru = Naru.open({ db: ':memory:', retentionMode: mode })
      naru.addMemory({
        scope: { type: 'project', key: 'webapp' },
        text: 'Alice prefers dark mode',
        subject: 'Alice',
        predicate: 'prefers',
        object: 'dark mode',
      })

      const bundle = naru.exportBundle()

      expect(bundle.retentionMode).toBe(mode)
      // Facts are still exported (they are canonical under minimal/none, §10.1).
      expect(bundle.facts.length).toBeGreaterThan(0)
      // But NO episode body or evidence quote text leaves the store.
      for (const ep of bundle.episodes) {
        expect(ep.redactedText).toBeNull()
        // Structure/provenance is preserved: the source hash still travels.
        expect(ep.sourceHash.length).toBeGreaterThan(0)
      }
      for (const ev of bundle.evidence) {
        expect(ev.redactedQuote).toBeNull()
      }
    })
  }

  it('keeps episode/evidence text under the default redacted retention', () => {
    naru = Naru.open({ db: ':memory:' })
    naru.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    const bundle = naru.exportBundle()

    expect(bundle.retentionMode).toBe('redacted')
    expect(bundle.episodes.some((e) => e.redactedText !== null)).toBe(true)
    expect(bundle.evidence.some((e) => e.redactedQuote !== null)).toBe(true)
  })
})

/**
 * STORAGE-LAYER retention guard (plan §10.1): the extraction commit path must
 * not PERSIST evidence quote text under `minimal`/`none`. The bundle export
 * strips quotes at export time, so an export-only assertion would pass even if
 * the live DB held the text — and `naru backup` is a raw VACUUM INTO copy that
 * would then exfiltrate it. So assert the raw `evidence.redacted_quote` COLUMN
 * directly after a capture that ran the mock extractor (the leaking path).
 */
describe('extractor evidence quote respects retention at STORAGE (plan §10.1)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  const secret = 'Alice prefers dark mode'

  it('minimal: stores NO quote text but keeps the quote hash', async () => {
    naru = Naru.open({ db: ':memory:', retentionMode: 'minimal', llm: { provider: 'mock' } })
    await naru.capture({ scope: { type: 'project', key: 'webapp' }, text: secret })

    const rows = rawEvidence(naru)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // No quote TEXT persisted (facts + evidence HASHES only, §10.1).
      expect(row.redacted_quote).toBeNull()
      // The hash is retained under `minimal` for dedupe/provenance.
      expect(row.quote_hash).not.toBeNull()
    }
  })

  it('none: stores neither quote text nor quote hash', async () => {
    naru = Naru.open({ db: ':memory:', retentionMode: 'none', llm: { provider: 'mock' } })
    await naru.capture({ scope: { type: 'project', key: 'webapp' }, text: secret })

    const rows = rawEvidence(naru)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // Extracted facts only — no episode/evidence text AND no quote hash (§10.1).
      expect(row.redacted_quote).toBeNull()
      expect(row.quote_hash).toBeNull()
    }
  })

  it('redacted: still stores the quote text + hash (control)', async () => {
    naru = Naru.open({ db: ':memory:', retentionMode: 'redacted', llm: { provider: 'mock' } })
    await naru.capture({ scope: { type: 'project', key: 'webapp' }, text: secret })

    const rows = rawEvidence(naru)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.redacted_quote !== null && r.quote_hash !== null)).toBe(true)
  })
})

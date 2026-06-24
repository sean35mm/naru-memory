import { afterEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

describe('bundle contains only canonical tables (plan §12.2/§19)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  it('carries zero FTS / vector / index_state / embeddings rows', async () => {
    // Configure an embedder and reindex so the SOURCE store actually has vector
    // and FTS rows — the export must still exclude them.
    naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
    naru.addMemory({
      scope: { type: 'project', key: 'webapp' },
      text: 'Alice prefers dark mode',
      subject: 'Alice',
      predicate: 'prefers',
      object: 'dark mode',
    })
    await naru.reindexVectors()

    const bundle = naru.exportBundle()

    // The bundle's keys are exactly the canonical tables plus metadata — no
    // derived-index tables appear anywhere in the serialized payload.
    const json = JSON.stringify(bundle)
    for (const forbidden of [
      'facts_fts',
      'entities_fts',
      'fact_vectors',
      'index_state',
      'embeddings',
      'vector',
      'bm25',
    ]) {
      expect(json.includes(forbidden)).toBe(false)
    }

    // And the object exposes only the canonical arrays + metadata, nothing else.
    expect(Object.keys(bundle).sort()).toEqual(
      [
        'edges',
        'embedding',
        'entities',
        'episodes',
        'evidence',
        'exportedAt',
        'facts',
        'hashVersion',
        'retentionMode',
        'schemaVersion',
        'scopes',
        'supersessions',
      ].sort(),
    )
  })
})

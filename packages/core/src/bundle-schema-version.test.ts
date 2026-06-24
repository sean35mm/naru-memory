import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryBundle } from './bundle'
import { Naru } from './naru'

describe('bundle schema/hash version validation (plan §19)', () => {
  let naru: Naru

  afterEach(() => {
    naru?.close()
  })

  function exportSeeded(): MemoryBundle {
    const source = Naru.open({ db: ':memory:' })
    source.addMemory({ scope: { type: 'project', key: 'webapp' }, text: 'a fact' })
    const bundle = source.exportBundle()
    source.close()
    return bundle
  }

  it('rejects a bundle with an unknown schemaVersion instead of silently importing it', async () => {
    const bundle = exportSeeded()
    bundle.schemaVersion = '9999'

    naru = Naru.open({ db: ':memory:' })
    await expect(naru.importBundle(bundle)).rejects.toThrow(/schemaVersion/i)
    // Nothing was imported.
    const facts = naru.list()
    expect(facts.length).toBe(0)
  })

  it('rejects a bundle with a mismatched hashVersion', async () => {
    const bundle = exportSeeded()
    bundle.hashVersion = 999

    naru = Naru.open({ db: ':memory:' })
    await expect(naru.importBundle(bundle)).rejects.toThrow(/hashVersion/i)
    expect(naru.list().length).toBe(0)
  })

  it('accepts a bundle exported at the current schema/hash version', async () => {
    const bundle = exportSeeded()
    naru = Naru.open({ db: ':memory:' })
    const result = await naru.importBundle(bundle)
    expect(result.imported.facts).toBeGreaterThan(0)
  })
})

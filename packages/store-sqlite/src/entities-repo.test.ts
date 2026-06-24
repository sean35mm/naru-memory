import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeEntityKey } from './repositories/entities'
import { Store } from './store'

describe('EntitiesRepository.ensure', () => {
  let store: Store
  let scopeA: string
  let scopeB: string

  beforeEach(() => {
    store = Store.open({ path: ':memory:' })
    scopeA = store.scopes.ensure({ type: 'project', keyPart: 'a' }).id
    scopeB = store.scopes.ensure({ type: 'project', keyPart: 'b' }).id
  })

  it('dedupes by normalized key within the same scope', () => {
    const first = store.entities.ensure({
      scopeId: scopeA,
      type: 'tool',
      canonicalName: 'Vitest',
    })
    const second = store.entities.ensure({
      scopeId: scopeA,
      type: 'tool',
      canonicalName: '  vitest ',
    })

    expect(second.id).toBe(first.id)
    expect(store.entities.listByScope(scopeA)).toHaveLength(1)
  })

  it('treats the same normalized key in a different scope as a distinct entity', () => {
    const inA = store.entities.ensure({ scopeId: scopeA, type: 'tool', canonicalName: 'Vitest' })
    const inB = store.entities.ensure({ scopeId: scopeB, type: 'tool', canonicalName: 'Vitest' })

    expect(inB.id).not.toBe(inA.id)
    expect(store.entities.listByScope(scopeA)).toHaveLength(1)
    expect(store.entities.listByScope(scopeB)).toHaveLength(1)
  })

  it('normalizes name to a stable matching key', () => {
    expect(normalizeEntityKey('  Dark   Mode ')).toBe('dark mode')
  })
})

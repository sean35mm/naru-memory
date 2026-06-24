import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

describe('core entity/scope/index accessors (plan §15.2)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
  })

  afterEach(() => {
    naru.close()
  })

  it('listEntities returns scoped entities; unknown scope yields none', () => {
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({
      text: 'uses Postgres',
      scope,
      subject: 'Service',
      predicate: 'uses',
      object: 'Postgres',
    })

    const scoped = naru.listEntities(scope)
    expect(scoped.length).toBeGreaterThan(0)
    expect(naru.listEntities({ type: 'project', key: 'nope' })).toEqual([])
    // unscoped list spans all scopes (superset of the scoped list)
    expect(naru.listEntities().length).toBeGreaterThanOrEqual(scoped.length)
  })

  it('getEntity returns the entity with only its active linked facts', () => {
    const scope = { type: 'project' as const, key: 'app' }
    naru.addMemory({
      text: 'uses Postgres',
      scope,
      subject: 'Service',
      predicate: 'uses',
      object: 'Postgres',
    })
    const entity = naru.listEntities(scope)[0]
    if (!entity) {
      throw new Error('expected an entity')
    }

    const detail = naru.getEntity(entity.id)
    expect(detail?.entity.id).toBe(entity.id)
    expect(detail?.facts.every((f) => f.status === 'active')).toBe(true)
    expect(naru.getEntity('ent_missing')).toBeUndefined()
  })

  it('listScopes reflects created scopes and indexStatus lists derived indexes', () => {
    expect(naru.listScopes()).toEqual([])
    naru.addMemory({ text: 'x', scope: { type: 'user', key: 'sean' } })
    expect(naru.listScopes().map((s) => s.key)).toContain('user:sean')

    const idx = naru.indexStatus()
    expect(idx.map((s) => s.indexName).sort()).toEqual(['entities_fts', 'facts_fts'])
  })
})

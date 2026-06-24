import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

describe('dedupe (plan §13.5)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
  })

  afterEach(() => {
    naru.close()
  })

  it('adding the same text+scope twice yields one fact (same statement_hash)', () => {
    const scope = { type: 'project' as const, key: 'app' }
    const text = 'The API rate limit is 100 requests per minute.'

    const first = naru.addMemory({ text, scope })
    const second = naru.addMemory({ text, scope })

    expect(second.id).toBe(first.id)
    expect(second.statementHash).toBe(first.statementHash)

    const active = naru.list({ scope, status: 'active' })
    const matching = active.filter((f) => f.statementHash === first.statementHash)
    expect(matching).toHaveLength(1)
  })
})

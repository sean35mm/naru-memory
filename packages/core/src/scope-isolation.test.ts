import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Naru } from './naru'

describe('scope isolation (plan §9.4, §18.3)', () => {
  let naru: Naru

  beforeEach(() => {
    naru = Naru.open({ db: ':memory:' })
  })

  afterEach(() => {
    naru.close()
  })

  it('does not leak facts across project scopes', () => {
    naru.addMemory({
      text: 'The deploy command for AlphaService is pnpm deploy alpha.',
      scope: { type: 'project', key: 'a' },
    })
    naru.addMemory({
      text: 'The deploy command for BetaService is pnpm deploy beta.',
      scope: { type: 'project', key: 'b' },
    })

    const inA = naru.search({ query: 'deploy command', scope: { type: 'project', key: 'a' } })
    expect(inA.length).toBeGreaterThan(0)
    expect(inA.every((r) => r.scope === 'project:a')).toBe(true)
    expect(inA.some((r) => r.statement.includes('Beta'))).toBe(false)

    const inB = naru.search({ query: 'deploy command', scope: { type: 'project', key: 'b' } })
    expect(inB.length).toBeGreaterThan(0)
    expect(inB.every((r) => r.scope === 'project:b')).toBe(true)
    expect(inB.some((r) => r.statement.includes('Alpha'))).toBe(false)
  })

  it('a bare search with no scope and no global resolves to the empty set (plan §9.3/§9.4)', () => {
    naru.addMemory({
      text: 'The deploy command for AlphaService is pnpm deploy alpha.',
      scope: { type: 'project', key: 'a' },
    })
    naru.addMemory({ text: 'User prefers dark mode.', scope: { type: 'user', key: 'alice' } })

    // No selector + no global must NOT fan out to every project + user scope.
    expect(naru.search({ query: 'deploy' })).toHaveLength(0)
    expect(naru.search({ query: 'dark' })).toHaveLength(0)

    // Explicit global intent is still honored.
    const global = naru.search({ query: 'dark', global: true })
    expect(global.some((r) => /dark mode/i.test(r.statement))).toBe(true)
  })

  it("global bounded by globalUser excludes other users' user-scope facts (plan §9.1)", () => {
    naru.addMemory({ text: 'Alice prefers dark mode.', scope: { type: 'user', key: 'alice' } })
    naru.addMemory({ text: 'Bob prefers light mode.', scope: { type: 'user', key: 'bob' } })

    // Unbounded global sees BOTH users (the legacy, leaky behavior).
    const unbounded = naru.search({ query: 'mode', global: true })
    expect(unbounded.some((r) => r.scope === 'user:alice')).toBe(true)
    expect(unbounded.some((r) => r.scope === 'user:bob')).toBe(true)

    // Bounded to alice: only alice's user-scope fact is in the allowed set.
    const bounded = naru.search({ query: 'mode', global: true, globalUser: 'alice' })
    expect(bounded.some((r) => r.scope === 'user:alice')).toBe(true)
    expect(bounded.some((r) => r.scope === 'user:bob')).toBe(false)
  })
})

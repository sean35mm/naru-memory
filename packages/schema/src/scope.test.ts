import { describe, expect, it } from 'vitest'
import { DEFAULT_READ_ORDER, SCOPE_RANK, scopeKey } from './scope'

describe('scopeKey', () => {
  it('formats as `type:key`', () => {
    expect(scopeKey('project', 'naru-memory')).toBe('project:naru-memory')
    expect(scopeKey('user', 'sean')).toBe('user:sean')
  })
})

describe('SCOPE_RANK', () => {
  it('orders session > agent > branch > project > workspace > user > global', () => {
    expect(SCOPE_RANK.session).toBeGreaterThan(SCOPE_RANK.agent)
    expect(SCOPE_RANK.agent).toBeGreaterThan(SCOPE_RANK.branch)
    expect(SCOPE_RANK.branch).toBeGreaterThan(SCOPE_RANK.project)
    expect(SCOPE_RANK.project).toBeGreaterThan(SCOPE_RANK.workspace)
    expect(SCOPE_RANK.workspace).toBeGreaterThan(SCOPE_RANK.user)
    expect(SCOPE_RANK.user).toBeGreaterThan(SCOPE_RANK.global)
  })
})

describe('DEFAULT_READ_ORDER', () => {
  it('includes agent', () => {
    expect(DEFAULT_READ_ORDER).toContain('agent')
  })

  it('starts at session and ends at user, excluding global', () => {
    expect(DEFAULT_READ_ORDER[0]).toBe('session')
    expect(DEFAULT_READ_ORDER[DEFAULT_READ_ORDER.length - 1]).toBe('user')
    expect(DEFAULT_READ_ORDER).not.toContain('global')
  })
})

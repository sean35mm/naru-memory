import { describe, expect, it } from 'vitest'
import { newId } from './ids'

describe('newId', () => {
  it('includes the given prefix followed by an underscore', () => {
    const id = newId('fact')
    expect(id.startsWith('fact_')).toBe(true)
    expect(id.length).toBeGreaterThan('fact_'.length)
  })

  it('produces distinct ids on successive calls', () => {
    expect(newId('ent')).not.toBe(newId('ent'))
  })

  it('is lexicographically sortable by creation time', async () => {
    const first = newId('ev')
    // ULID time component has millisecond resolution; ensure the clock advances.
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = newId('ev')
    expect(first < second).toBe(true)
  })
})

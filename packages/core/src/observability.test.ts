import { describe, expect, it } from 'vitest'
import { type NaruEvent, type SanitizedEvent, createLogger, sanitizeEvent } from './logger'
import { Naru } from './naru'

/**
 * Observability MUST NOT leak memory contents (plan §18 logs / §20 M5).
 *
 * These tests feed a fact carrying BOTH a real-looking secret and a distinctive
 * memory phrase, drive add/forget/search through the facade with an in-memory
 * event collector wired in, then assert the serialized event stream contains
 * counts/ids/hashes but NEITHER the secret NOR the distinctive phrase anywhere.
 */

const SECRET = 'sk-proj-ABCDEF0123456789abcdef0123456789'
const PHRASE = 'zxqwvphraseneedle'

function collector(): { events: SanitizedEvent[]; sink: (e: SanitizedEvent) => void } {
  const events: SanitizedEvent[] = []
  return { events, sink: (e) => events.push(e) }
}

describe('observability event stream', () => {
  it('emits counts/ids for add+forget but never the secret or distinctive phrase', () => {
    const { events, sink } = collector()
    const naru = Naru.open({
      db: ':memory:',
      observability: { level: 'verbose' },
      eventSink: sink,
    })
    try {
      const fact = naru.addMemory({
        text: `User stored ${PHRASE} with key ${SECRET}`,
        scope: { type: 'project', key: 'acme' },
      })
      naru.search({ query: `${PHRASE} ${SECRET}`, scope: { type: 'project', key: 'acme' } })
      naru.forget({ factId: fact.id })

      // The stream captured the operations.
      const ops = events.map((e) => e.operation)
      expect(ops).toContain('add')
      expect(ops).toContain('search')
      expect(ops).toContain('forget')

      // The add event carries the fact id + a dedupe flag (ids/flags, not text).
      const add = events.find((e) => e.operation === 'add')
      expect(add).toBeDefined()
      if (add?.operation === 'add') {
        expect(add.factId).toBe(fact.id)
        expect(typeof add.deduped).toBe('boolean')
      }

      // The forget event carries a count + selector KINDS, not selector values.
      const forget = events.find((e) => e.operation === 'forget')
      if (forget?.operation === 'forget') {
        expect(forget.deleted).toBe(1)
        expect(forget.selectorKinds).toEqual(['factId'])
      }

      // The search event carries only query SHAPE (length) + counts, not text.
      const search = events.find((e) => e.operation === 'search')
      if (search?.operation === 'search') {
        expect(typeof search.queryLength).toBe('number')
        expect(typeof search.resultCount).toBe('number')
        // queryLength is a number, not the query string.
        expect(search).not.toHaveProperty('query')
      }

      // The whole serialized stream must contain neither the secret nor phrase.
      const serialized = JSON.stringify(events)
      expect(serialized).not.toContain(SECRET)
      expect(serialized).not.toContain(PHRASE)
      // The redactor's placeholder also must not have smuggled raw secret bytes.
      expect(serialized).not.toContain('ABCDEF0123456789')
    } finally {
      naru.close()
    }
  })

  it('is OFF by default: no events emitted unless opted in', () => {
    const { events, sink } = collector()
    const naru = Naru.open({ db: ':memory:', eventSink: sink })
    try {
      naru.addMemory({ text: PHRASE, scope: { type: 'project', key: 'acme' } })
      naru.search({ query: PHRASE, scope: { type: 'project', key: 'acme' } })
      expect(events).toHaveLength(0)
    } finally {
      naru.close()
    }
  })

  it('quiet level suppresses debug events (search) but keeps info events (add)', () => {
    const { events, sink } = collector()
    const naru = Naru.open({
      db: ':memory:',
      observability: { level: 'quiet' },
      eventSink: sink,
    })
    try {
      naru.addMemory({ text: 'hello', scope: { type: 'project', key: 'acme' } })
      naru.search({ query: 'hello', scope: { type: 'project', key: 'acme' } })
      const ops = events.map((e) => e.operation)
      expect(ops).toContain('add') // info
      expect(ops).not.toContain('search') // debug, below quiet threshold
    } finally {
      naru.close()
    }
  })
})

describe('sanitizeEvent defense-in-depth', () => {
  it('redacts a secret even if a string field is mis-wired to carry one', () => {
    // Fabricate a structurally-valid event whose allowlisted `errorCode` field
    // has been (wrongly) stuffed with a secret. The sanitizer must scrub it.
    const event = {
      operation: 'add',
      level: 'error',
      factId: 'fact_01',
      deduped: false,
      errorCode: `leak ${SECRET}`,
    } as unknown as NaruEvent
    const sanitized = sanitizeEvent(event, '2026-01-01T00:00:00.000Z')
    const serialized = JSON.stringify(sanitized)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).toContain('[REDACTED:')
  })

  it('drops non-allowlisted string fields entirely (fail closed)', () => {
    const event = {
      operation: 'search',
      level: 'debug',
      queryLength: 5,
      resultCount: 0,
      hybrid: false,
      // A rogue field carrying memory text — must be dropped, not emitted.
      query: PHRASE,
    } as unknown as NaruEvent
    const sanitized = sanitizeEvent(event, '2026-01-01T00:00:00.000Z')
    expect(sanitized).not.toHaveProperty('query')
    expect(JSON.stringify(sanitized)).not.toContain(PHRASE)
    // Numeric fields survive.
    expect((sanitized as { queryLength: number }).queryLength).toBe(5)
  })

  it('createLogger with off level never invokes the sink', () => {
    let called = 0
    const logger = createLogger({ level: 'off' }, () => {
      called++
    })
    logger.emit({
      operation: 'add',
      level: 'info',
      factId: 'f1',
      deduped: false,
    })
    expect(called).toBe(0)
    expect(logger.enabled).toBe(false)
  })
})

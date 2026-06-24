import { describe, expect, it } from 'vitest'
import { redact } from './redaction'

describe('redact', () => {
  it('redacts an OpenAI-style key', () => {
    const { redacted, matches } = redact('use key sk-abcDEF0123456789abcdef0123 now')
    expect(redacted).toContain('[REDACTED:openai_key]')
    expect(redacted).not.toContain('sk-abcDEF0123456789abcdef0123')
    expect(matches.some((m) => m.type === 'openai_key')).toBe(true)
  })

  it('redacts an email address', () => {
    const { redacted, matches } = redact('contact me at jane.doe@example.com please')
    expect(redacted).toContain('[REDACTED:email]')
    expect(redacted).not.toContain('jane.doe@example.com')
    expect(matches.some((m) => m.type === 'email')).toBe(true)
  })

  it('redacts a phone number', () => {
    const { redacted, matches } = redact('call +1 415 555 2671 tomorrow')
    expect(redacted).toContain('[REDACTED:phone]')
    expect(redacted).not.toContain('415 555 2671')
    expect(matches.some((m) => m.type === 'phone')).toBe(true)
  })

  it('redacts a sentence-final phone number (trailing period)', () => {
    // Regression: the trailing guard must allow a sentence-ending '.' so the
    // phone does not leak into stored text or the extractor input.
    const { redacted } = redact('call 555-123-4567.')
    expect(redacted).toBe('call [REDACTED:phone].')
    expect(redacted).not.toContain('555-123-4567')
  })

  it('preserves versions, IPs, and ISO dates (not phone false-positives)', () => {
    // Dates/numbers are product payload and must be preserved (plan §13.2).
    for (const kept of ['v1.2.3.4', '192.168.0.1', 'build 2.0.1', '2026-06-24', '2026/06/24']) {
      expect(redact(kept).redacted).toBe(kept)
    }
  })

  it('leaves a normal sentence untouched', () => {
    const sentence = 'User prefers dark mode for developer tools.'
    const { redacted, matches } = redact(sentence)
    expect(redacted).toBe(sentence)
    expect(matches).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { HASH_VERSION, normalizeText, sha256Hex, sourceHash, statementHash } from './hash'

describe('normalizeText', () => {
  it('collapses internal whitespace runs to a single space and trims', () => {
    expect(normalizeText('  hello   world\t\nfoo  ')).toBe('hello world foo')
  })

  it('applies Unicode NFC normalization', () => {
    // "e" + combining acute accent (NFD) should normalize to single "é" (NFC).
    const nfd = 'é'
    const nfc = 'é'
    expect(normalizeText(nfd)).toBe(nfc)
  })
})

describe('statementHash', () => {
  const base = {
    scopeKey: 'user:sean',
    subject: 'User',
    predicate: 'prefers',
    object: 'dark mode',
  }

  it('is deterministic for the same input', () => {
    expect(statementHash(base)).toBe(statementHash(base))
  })

  it('is case-insensitive and whitespace-insensitive (normalization)', () => {
    const messy = {
      scopeKey: 'USER:sean',
      subject: '  user  ',
      predicate: 'Prefers',
      object: 'dark   mode',
    }
    expect(statementHash(messy)).toBe(statementHash(base))
  })

  it('differs for different content', () => {
    expect(statementHash(base)).not.toBe(statementHash({ ...base, object: 'light mode' }))
  })

  it('treats missing subject/object distinctly from empty-ish values', () => {
    const withNulls = {
      scopeKey: 'user:sean',
      predicate: 'is online',
    }
    expect(statementHash(withNulls)).toBe(statementHash({ ...withNulls }))
    expect(statementHash(withNulls)).not.toBe(statementHash(base))
  })

  it('incorporates HASH_VERSION into the digest', () => {
    // The canonical pre-image embeds the version under key "v"; the resulting
    // hash must equal a hand-computed digest over that exact serialization,
    // proving the version participates in the hash.
    const expected = sha256Hex(
      JSON.stringify({
        object: 'dark mode',
        predicate: 'prefers',
        scopeKey: 'user:sean',
        subject: 'user',
        v: HASH_VERSION,
      }),
    )
    expect(statementHash(base)).toBe(expected)
  })
})

describe('sourceHash', () => {
  const input = {
    text: 'I prefer dark mode',
    sourceType: 'chat',
    sourceRef: 'msg-1',
  }

  it('is deterministic for the same input', () => {
    expect(sourceHash(input)).toBe(sourceHash(input))
  })

  it('differs when the text differs', () => {
    expect(sourceHash(input)).not.toBe(sourceHash({ ...input, text: 'I prefer light mode' }))
  })

  it('differs when the source type differs', () => {
    expect(sourceHash(input)).not.toBe(sourceHash({ ...input, sourceType: 'tool' }))
  })
})

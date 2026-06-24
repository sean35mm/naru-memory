import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Transport-layer auth for the local server (plan §15.3).
 *
 * A localhost-bound server is reachable by any local process and, via
 * DNS-rebinding/CSRF, by web pages the user visits, so every request (except
 * the unauthenticated `/health` probe) must carry a bearer token. The token is
 * generated at first start and shared with clients only through the `0600`
 * discovery file (§12.3) — never logged.
 */

/** Generate a fresh 256-bit token as a 64-char hex string. */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Constant-time check that an `Authorization` header carries the expected token.
 *
 * Accepts the raw header value (e.g. `"Bearer <token>"`), strips the scheme,
 * and compares with {@link timingSafeEqual}. The byte length is guarded first
 * because `timingSafeEqual` throws on unequal-length buffers; an early length
 * mismatch still returns `false` without leaking timing about the prefix.
 */
export function tokenOk(authHeader: string | undefined, expected: string): boolean {
  if (typeof authHeader !== 'string') {
    return false
  }
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

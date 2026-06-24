/**
 * Secret + PII redaction (plan §18.1).
 *
 * IMPORTANT: This is **best-effort defense-in-depth, not a hard guarantee**
 * (plan §18.1). Pattern/regex redaction will miss secrets in custom or
 * non-standard formats. "Redacted" is never proof that no secret remains;
 * downstream layers (embeddings, logs, prompt injection) must still minimize
 * blast radius. Where feasible, prefer not capturing high-risk material at all
 * over relying on this to scrub it.
 *
 * Redaction runs in a single pre-persistence pass (plan §10.2, §18.1): secrets
 * and sensitive PII (emails, phone numbers) are replaced with
 * `[REDACTED:<type>]`. Non-sensitive personal preferences/conventions are the
 * product's payload and are intentionally retained.
 */

/** A single redaction hit, tagged by the kind of secret/PII matched. */
export interface RedactionMatch {
  type: string
}

/** Result of a redaction pass. */
export interface RedactionResult {
  redacted: string
  matches: RedactionMatch[]
}

/** Options for {@link redact}. */
export interface RedactOptions {
  /**
   * Substrings (case-insensitive) exempt from the high-entropy catch-all so
   * legitimate long identifiers (e.g. ULIDs, commit SHAs) are not scrubbed.
   */
  entropyAllowlist?: string[]
}

/**
 * Ordered redaction patterns. Order matters: more specific/structured secret
 * shapes run before the generic high-entropy catch-all so they keep their
 * precise type label.
 *
 * Each rule replaces every match with `[REDACTED:<type>]`.
 */
interface RedactionRule {
  type: string
  pattern: RegExp
}

const RULES: RedactionRule[] = [
  // PRIVATE KEY blocks (PEM). Match the whole block including header/footer.
  {
    type: 'private_key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  // OpenAI-style keys: sk-... (incl. sk-proj-..., sk-ant-...). >= 20 chars body.
  {
    type: 'openai_key',
    pattern: /\bsk-(?:[a-zA-Z]+-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36+ base62.
  {
    type: 'github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  // AWS access key IDs.
  {
    type: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  // Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-...
  {
    type: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // Bearer tokens in Authorization-style headers/strings.
  {
    type: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g,
  },
  // .env-style secret assignments: NAME_SECRET=value / API_TOKEN: "value".
  // Captures the assignment operator + value, preserves the key name prefix.
  {
    type: 'env_secret',
    pattern:
      /(\b[A-Za-z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PWD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi,
  },
  // Email addresses (sensitive PII, plan §18.1).
  {
    type: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  // Phone numbers (sensitive PII): international/US-ish, 10+ digits with seps.
  // - Leading guard skips ISO-date shapes (YYYY-MM-DD) so dates are preserved
  //   (plan §13.2), not redacted as phones.
  // - Trailing guard allows a sentence-ending '.' (so "...4567." is redacted)
  //   but still rejects a continuing digit run like a version/IP ("1.2.3.4").
  {
    type: 'phone',
    pattern:
      /(?<![\w.])(?!\d{4}[-/.]\d{2}[-/.]\d{2}\b)\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\w)(?![.-]?\d)/g,
  },
]

const REDACTION_PLACEHOLDER = (type: string): string => `[REDACTED:${type}]`

/**
 * Generic high-entropy token catch-all (plan §18.1): long base64/hex-ish
 * strings that look like unknown secret formats. Conservative: requires >= 20
 * chars, a mix of character classes (so plain words and pure hex IDs are less
 * likely to trip), and respects the allowlist.
 */
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9+/_=-]{20,}\b/g

/** Heuristic: does this token look like a high-entropy secret rather than prose? */
function looksHighEntropy(token: string): boolean {
  const hasLower = /[a-z]/.test(token)
  const hasUpper = /[A-Z]/.test(token)
  const hasDigit = /[0-9]/.test(token)
  const classes = [hasLower, hasUpper, hasDigit].filter(Boolean).length
  // Require at least two character classes AND at least one digit: long
  // all-letter words ("internationalization") and pure-letter identifiers stay.
  return classes >= 2 && hasDigit
}

/**
 * Redact secrets and sensitive PII from `text` (plan §18.1).
 *
 * Returns the redacted text and the list of matched types. Best-effort — see
 * the module doc comment. Applies structured rules first, then a high-entropy
 * catch-all that honors `opts.entropyAllowlist`.
 */
export function redact(text: string, opts: RedactOptions = {}): RedactionResult {
  const matches: RedactionMatch[] = []
  let out = text

  for (const rule of RULES) {
    out = out.replace(rule.pattern, (full: string, ...args: unknown[]) => {
      // env_secret captures a key-prefix group we want to preserve.
      if (rule.type === 'env_secret' && typeof args[0] === 'string') {
        matches.push({ type: rule.type })
        return `${args[0]}${REDACTION_PLACEHOLDER(rule.type)}`
      }
      matches.push({ type: rule.type })
      return REDACTION_PLACEHOLDER(rule.type)
    })
  }

  const allowlist = (opts.entropyAllowlist ?? []).map((a) => a.toLowerCase())
  out = out.replace(HIGH_ENTROPY_PATTERN, (token: string) => {
    if (token.startsWith('[REDACTED:')) {
      return token
    }
    const lower = token.toLowerCase()
    if (allowlist.some((a) => lower.includes(a))) {
      return token
    }
    if (!looksHighEntropy(token)) {
      return token
    }
    matches.push({ type: 'high_entropy' })
    return REDACTION_PLACEHOLDER('high_entropy')
  })

  return { redacted: out, matches }
}

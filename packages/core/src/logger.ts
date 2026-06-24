/**
 * Structured observability seam (plan §18, §20 M5: "observability without
 * leaking memory contents").
 *
 * This module emits typed events describing WHAT happened (operation, counts,
 * ids, hashes, durationMs, scope KEY, types) — and by construction it is
 * IMPOSSIBLE to emit a fact statement, episode body, evidence quote, entity
 * name, or a secret through it:
 *
 *  - The event payloads are a CLOSED, typed union ({@link NaruEvent}). There is
 *    no free-form `message` / `text` / `detail` string field anywhere a caller
 *    could stuff memory content.
 *  - Every payload field is either a small enum (operation/scope type), an
 *    opaque id, a content HASH, a numeric count/duration, a boolean, or a scope
 *    KEY (a routing label like `proj:acme`, never memory payload). Scope keys
 *    and ids are emitted as-is because they are routing identifiers, not memory.
 *  - The {@link sanitizeEvent} guard is a defense-in-depth second pass
 *    (plan §18.1, redaction is best-effort): before an event reaches a sink it
 *    is structurally re-validated and string fields are run through the same
 *    redactor used pre-persistence, so even a future mis-wired emit cannot leak
 *    a secret-shaped string.
 *
 * The logger is OFF (or `quiet`) by default; it is opt-in via config/env
 * ({@link resolveObservability}). When disabled, emit is a cheap no-op.
 */

import { redact } from './redaction'

/** Operations the services emit events for (plan §13/§14/§18, §19, §22). */
export type NaruOperation =
  | 'add'
  | 'capture'
  | 'search'
  | 'forget'
  | 'import'
  | 'export'
  | 'repair'
  | 'integrity'
  | 'backup'

/** Event severity. `error` events still carry NO memory content (codes only). */
export type NaruEventLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Non-sensitive scope descriptor for an event (plan §9). Carries the scope
 * `type` and routing `key` (e.g. `proj:acme`) — a label, never memory payload.
 */
export interface EventScope {
  type: string
  key: string
}

/**
 * Fields common to every event. Deliberately a closed set of non-sensitive
 * primitives — NO free-form text field exists for memory content to ride in.
 */
interface BaseEvent {
  operation: NaruOperation
  level: NaruEventLevel
  /** Wall-clock duration of the operation, when measured. */
  durationMs?: number
  /** Scope the operation acted in/over, as a routing descriptor (not payload). */
  scope?: EventScope
  /** Non-sensitive outcome code for failures (e.g. `embed_failed`); never text. */
  errorCode?: string
}

/** `memory.add` (manual, infer=false): a fact was inserted or deduped. */
export interface AddEvent extends BaseEvent {
  operation: 'add'
  /** The resulting fact id (opaque ULID). */
  factId: string
  /** Portable statement hash (content-addressed, not reversible to text). */
  statementHash?: string
  /** True when an existing active/replacement fact was returned (idempotent). */
  deduped: boolean
}

/** `episode.capture` + extraction: counts of what the ingest touched. */
export interface CaptureEvent extends BaseEvent {
  operation: 'capture'
  episodeId: string
  /** Number of facts created/updated this run (count only, never the facts). */
  factCount: number
  /** Whether extraction ran (an extractor was configured) or it fell back. */
  extracted: boolean
}

/** `memory.search` / hybrid search: query SHAPE only — never the query text. */
export interface SearchEvent extends BaseEvent {
  operation: 'search'
  /** Length of the (redacted) query string in characters — not the text. */
  queryLength: number
  /** Number of results returned (count only). */
  resultCount: number
  /** Whether the vector signal participated (an embedder was configured). */
  hybrid: boolean
}

/** `memory.forget`: a destructive privacy purge — count + selector KINDS only. */
export interface ForgetEvent extends BaseEvent {
  operation: 'forget'
  /** Rows deleted (count only). */
  deleted: number
  /** Which selector fields were used (e.g. `['scope','before']`) — never values. */
  selectorKinds: string[]
}

/** `bundle` import/export: canonical row counts only, never row contents. */
export interface BundleEvent extends BaseEvent {
  operation: 'import' | 'export'
  /** Canonical counts touched, by table (counts only). */
  counts: Record<string, number>
  /** Whether vector re-embedding is still needed after import (no embedder). */
  reembedNeeded?: boolean
  /**
   * Whether the configured embedder differs from the bundle's recorded embedding
   * provenance, so facts were re-embedded into a different semantic space (plan
   * §19 mismatch warning). Boolean only — provider/model are not emitted here.
   */
  embeddingMismatch?: boolean
}

/** `repair`: derived/orphan rows changed — all counts (privacy-safe). */
export interface RepairEvent extends BaseEvent {
  operation: 'repair'
  ftsRebuilt: boolean
  vectorsEmbedded: number | null
  prunedTotal: number
}

/** `integrity` check: problem KINDS + counts only (mirrors IntegrityReport). */
export interface IntegrityEvent extends BaseEvent {
  operation: 'integrity'
  ok: boolean
  /** Problem counts keyed by kind (e.g. `orphan_evidence_fact`) — never ids. */
  problems: Record<string, number>
}

/** `backup`: a snapshot was written — byte size + verified canonical counts. */
export interface BackupEvent extends BaseEvent {
  operation: 'backup'
  /** Backup file size in bytes (count only). */
  bytes: number
  /** Whether the post-backup count verification matched the source. */
  verified: boolean
}

/** The closed event union the services emit. No variant carries memory text. */
export type NaruEvent =
  | AddEvent
  | CaptureEvent
  | SearchEvent
  | ForgetEvent
  | BundleEvent
  | RepairEvent
  | IntegrityEvent
  | BackupEvent

/** A sink consumes sanitized events (e.g. JSON-line stderr, a test collector). */
export type EventSink = (event: SanitizedEvent) => void

/**
 * An event after the defense-in-depth sanitize pass: structurally identical to
 * the input event with a `ts` ISO timestamp stamped on. Any string field has
 * been re-run through the redactor; non-allowlisted fields are dropped.
 */
export type SanitizedEvent = NaruEvent & { ts: string }

/** Observability verbosity (plan §23 config). `off` makes emit a no-op. */
export type ObservabilityLevel = 'off' | 'quiet' | 'verbose'

/** Resolved observability configuration. */
export interface ObservabilityConfig {
  level: ObservabilityLevel
}

/** Default: OFF. Observability is strictly opt-in (plan §18 logs caveat). */
export const DEFAULT_OBSERVABILITY: ObservabilityConfig = { level: 'off' }

/** Minimum event level emitted at each verbosity (debug events need `verbose`). */
const LEVEL_THRESHOLD: Record<ObservabilityLevel, number> = {
  off: Number.POSITIVE_INFINITY,
  quiet: 2, // info and above
  verbose: 0, // everything
}

const LEVEL_RANK: Record<NaruEventLevel, number> = {
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

/**
 * Resolve observability config from an explicit value, then the `NARU_LOG`
 * environment variable, else OFF. Recognized env values: `off`, `quiet`,
 * `verbose` (case-insensitive); anything else falls back to OFF so a typo never
 * silently enables logging.
 */
export function resolveObservability(
  explicit?: ObservabilityConfig,
  env: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  if (explicit) {
    return explicit
  }
  const raw = env.NARU_LOG?.toLowerCase().trim()
  if (raw === 'quiet' || raw === 'verbose' || raw === 'off') {
    return { level: raw }
  }
  return DEFAULT_OBSERVABILITY
}

/**
 * Keys whose STRING value is an opaque structural identifier — an operation/
 * level enum, an opaque row id (ULID), a content hash, or the timestamp. These
 * are routing identifiers, NOT memory payload, and must be emitted VERBATIM:
 * they must NOT pass through the secret redactor, whose high-entropy catch-all
 * would otherwise scrub a perfectly safe ULID/hash (plan §18: ids/hashes are
 * the privacy-safe surface).
 */
const IDENTIFIER_KEYS = new Set<string>([
  'operation',
  'level',
  'factId',
  'episodeId',
  'statementHash',
  'ts',
])

/**
 * Keys allowed to carry a free-form-ish string that, while non-sensitive by
 * design, is run through the redactor as defense-in-depth (so a mis-wired emit
 * can never leak a secret-shaped value). `errorCode` is the only such field.
 * Any string-valued key on NEITHER list is dropped (fail closed).
 */
const REDACTED_STRING_KEYS = new Set<string>(['errorCode'])

/** Scope-descriptor keys allowed to carry strings (type + routing key). */
const SCOPE_STRING_KEYS = new Set<string>(['type', 'key'])

/**
 * Defense-in-depth sanitizer (plan §18.1). Rebuilds the event from a known-safe
 * shape: copies through numbers/booleans, runs every allowlisted string field
 * through the redactor (so a secret-shaped value can never reach a sink), maps
 * count/problem records to numbers only, and DROPS any string-valued field not
 * on the allowlist. This is the last line of defense if a caller ever mis-wires
 * an emit — the type system already prevents most leaks; this catches the rest.
 */
export function sanitizeEvent(event: NaruEvent, ts: string): SanitizedEvent {
  const out: Record<string, unknown> = { ts }
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || value === null) {
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
      continue
    }
    if (typeof value === 'string') {
      if (IDENTIFIER_KEYS.has(key)) {
        // Opaque identifier (id/hash/enum/ts): emit verbatim, never redacted.
        out[key] = value
      } else if (REDACTED_STRING_KEYS.has(key)) {
        // Non-sensitive free-form code: scrub as defense-in-depth.
        out[key] = redact(value).redacted
      }
      // Strings on neither list are dropped (fail closed).
      continue
    }
    if (Array.isArray(value)) {
      // Only string[] arrays are expected (e.g. selectorKinds): redact each.
      out[key] = value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => redact(v).redacted)
      continue
    }
    if (key === 'scope' && typeof value === 'object') {
      const scope = value as Record<string, unknown>
      const safeScope: Record<string, string> = {}
      for (const sk of SCOPE_STRING_KEYS) {
        const sv = scope[sk]
        if (typeof sv === 'string') {
          safeScope[sk] = redact(sv).redacted
        }
      }
      out[key] = safeScope
      continue
    }
    if ((key === 'counts' || key === 'problems') && typeof value === 'object') {
      // Record<string, number>: keep numeric values only; keys are enum-like.
      const rec = value as Record<string, unknown>
      const safeRec: Record<string, number> = {}
      for (const [rk, rv] of Object.entries(rec)) {
        if (typeof rv === 'number') {
          safeRec[rk] = rv
        }
      }
      out[key] = safeRec
    }
    // Unknown object shape: drop (fail closed).
  }
  return out as unknown as SanitizedEvent
}

/**
 * Structured event logger seam (plan §18, §20 M5).
 *
 * Construct via {@link createLogger}. Services call {@link emit} with a typed
 * {@link NaruEvent}; when enabled the event is sanitized and forwarded to the
 * sink. When disabled (`off`, the default) emit returns immediately.
 */
export class Logger {
  private readonly threshold: number

  constructor(
    private readonly config: ObservabilityConfig,
    private readonly sink: EventSink,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.threshold = LEVEL_THRESHOLD[config.level]
  }

  /** Whether any event would currently be emitted (cheap pre-check for callers). */
  get enabled(): boolean {
    return this.config.level !== 'off'
  }

  /**
   * Emit a typed event. No-op when disabled or below the verbosity threshold.
   * The event is always run through {@link sanitizeEvent} before the sink so a
   * sink can NEVER observe memory content, even if an emit is mis-wired.
   */
  emit(event: NaruEvent): void {
    if (!this.enabled) {
      return
    }
    if (LEVEL_RANK[event.level] < this.threshold) {
      return
    }
    this.sink(sanitizeEvent(event, this.now()))
  }
}

/**
 * Default sink: one compact JSON line per event to stderr. Stderr (not stdout)
 * so it never corrupts the CLI's `--json` envelope on stdout. Used when
 * observability is enabled and no custom sink is injected.
 */
export const stderrJsonSink: EventSink = (event) => {
  process.stderr.write(`${JSON.stringify(event)}\n`)
}

/**
 * Build a {@link Logger}. When the resolved level is `off` the sink is never
 * invoked. A custom `sink` (e.g. an in-memory collector for tests) overrides
 * the default stderr JSON sink.
 */
export function createLogger(
  config: ObservabilityConfig = DEFAULT_OBSERVABILITY,
  sink: EventSink = stderrJsonSink,
): Logger {
  return new Logger(config, sink)
}

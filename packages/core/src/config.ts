import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_RETENTION, type RetentionMode, RetentionModeSchema } from '@naru/schema'
import { z } from 'zod'
import { DEFAULT_OBSERVABILITY, type ObservabilityConfig, type ObservabilityLevel } from './logger'

/**
 * Current on-disk config schema version (plan §23, §20 M5 config migration).
 *
 * Bump this whenever the persisted config SHAPE changes in a
 * non-backward-compatible way and add a migration step in {@link migrateConfig}.
 * The version is surfaced in `status()` so an operator can see which schema the
 * loaded config was migrated to.
 */
export const CONFIG_VERSION = 1

/**
 * Resolved Naru runtime configuration (plan §23).
 *
 * Later milestones (server, llm, embeddings, privacy toggles) extend this shape
 * behind clean seams. `configVersion` records the on-disk schema version this
 * config was loaded/migrated from ({@link CONFIG_VERSION} for in-memory/default
 * configs that never touched disk).
 */
export interface NaruConfig {
  /** On-disk config schema version this config was migrated to (plan §23). */
  configVersion: number
  /** Absolute filesystem path to the canonical SQLite DB, or ':memory:'. */
  dbPath: string
  /** Episode text retention mode (plan §10.1). */
  retentionMode: RetentionMode
  /** Observability verbosity (plan §18 logs / §20 M5). Defaults to OFF. */
  observability: ObservabilityConfig
  /**
   * Optional LLM extractor configuration (plan §6.2, §13.2). When unset (or
   * `provider: 'none'`) extraction is unavailable and the `add --infer=false`
   * path remains the only ingestion route (plan §13.3). Consumed by
   * `createExtractor` in the extraction layer.
   */
  llm?: LlmConfig
  /**
   * Optional embeddings configuration (plan §6.2, §11.9, M3 vector retrieval).
   * When unset (or `provider: 'none'`) vector retrieval is OFF and search
   * degrades gracefully to BM25/entity/recency (plan §6.2). Consumed by
   * `createEmbedder` in the embedding layer.
   */
  embeddings?: EmbeddingsConfig
}

/** Supported embedder provider identifiers (plan §6.2). */
export type EmbeddingProvider = 'none' | 'mock' | 'openai-compat' | 'ollama'

/** Optional embeddings configuration (plan §6.2, §11.9). */
export interface EmbeddingsConfig {
  /** Which embedder backend to use; `none` (or unset) disables vector retrieval. */
  provider: EmbeddingProvider
  /** OpenAI-compatible base URL (e.g. `http://localhost:11434`). */
  baseUrl?: string
  /** Embedding model identifier for the configured provider. */
  model?: string
  /** Optional API key for the OpenAI-compatible endpoint. */
  apiKey?: string
}

/** Supported extractor provider identifiers (plan §6.2). */
export type LlmProvider = 'none' | 'mock' | 'openai-compat' | 'ollama'

/** Optional LLM extractor configuration (plan §6.2, §13.2). */
export interface LlmConfig {
  /** Which extractor backend to use; `none` (or unset) disables extraction. */
  provider: LlmProvider
  /** OpenAI-compatible base URL (e.g. `http://localhost:11434`). */
  baseUrl?: string
  /** Model identifier for the configured provider. */
  model?: string
  /** Optional API key for the OpenAI-compatible endpoint. */
  apiKey?: string
}

/** Optional overrides for {@link resolveConfig}. */
export interface ResolveConfigOptions {
  /** Override the DB path; ':memory:' is honored as-is for tests. */
  db?: string
  /** Override the retention mode; defaults to `redacted` (plan §10.2). */
  retentionMode?: RetentionMode
  /** Override observability verbosity; defaults to OFF (plan §18). */
  observability?: ObservabilityConfig
  /** Optional LLM extractor configuration (plan §6.2, §13.2). */
  llm?: LlmConfig
  /** Optional embeddings configuration (plan §6.2, §11.9). */
  embeddings?: EmbeddingsConfig
}

/** Default on-disk DB location (plan §23): `~/.local/share/naru-memory/naru.db`. */
export function defaultDbPath(): string {
  return join(homedir(), '.local', 'share', 'naru-memory', 'naru.db')
}

/**
 * Expand a leading `~` to the user's home directory and make the path absolute.
 * `:memory:` is passed through untouched so tests can use an in-memory DB.
 */
function expandPath(path: string): string {
  if (path === ':memory:') {
    return path
  }
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  if (isAbsolute(path)) {
    return path
  }
  return join(process.cwd(), path)
}

/**
 * Resolve a {@link NaruConfig} from optional overrides plus defaults.
 *
 * Defaults: DB at {@link defaultDbPath}, retention `redacted` (plan §10.2, §23).
 */
export function resolveConfig(options: ResolveConfigOptions = {}): NaruConfig {
  const rawPath = options.db ?? defaultDbPath()
  const config: NaruConfig = {
    configVersion: CONFIG_VERSION,
    dbPath: expandPath(rawPath),
    retentionMode: options.retentionMode ?? DEFAULT_RETENTION,
    observability: options.observability ?? DEFAULT_OBSERVABILITY,
  }
  if (options.llm) {
    config.llm = options.llm
  }
  if (options.embeddings) {
    config.embeddings = options.embeddings
  }
  return config
}

/** Provider enum shared by the llm/embeddings config blocks (plan §6.2). */
const ProviderSchema = z.enum(['none', 'mock', 'openai-compat', 'ollama'])

/** One provider config block (`llm` / `embeddings`) as persisted on disk. */
const ProviderConfigSchema = z
  .object({
    provider: ProviderSchema,
    baseUrl: z.string().optional(),
    // Plan §23: model names are not required until the user configures one; a
    // persisted `null` (the template default) is accepted and treated as unset.
    model: z.string().nullable().optional(),
    apiKey: z.string().optional(),
  })
  .strict()

const ObservabilityLevelSchema: z.ZodType<ObservabilityLevel> = z.enum(['off', 'quiet', 'verbose'])

/**
 * The CURRENT on-disk config schema (plan §23, version {@link CONFIG_VERSION}).
 *
 * Mirrors the §23 template: nested `storage`/`retention`/`observability`/`llm`/
 * `embeddings` blocks, plus a top-level `configVersion`. `.strict()` rejects
 * unknown keys so a malformed/foreign config fails loudly rather than silently
 * dropping fields. This validates the shape AFTER {@link migrateConfig} has
 * upgraded any older shape, so older files never reach this schema directly.
 */
const CurrentConfigSchema = z
  .object({
    configVersion: z.literal(CONFIG_VERSION),
    storage: z
      .object({
        provider: z.literal('sqlite').optional(),
        path: z.string().optional(),
      })
      .strict()
      .optional(),
    retention: z.object({ mode: RetentionModeSchema }).strict().optional(),
    observability: z.object({ level: ObservabilityLevelSchema }).strict().optional(),
    llm: ProviderConfigSchema.optional(),
    embeddings: ProviderConfigSchema.optional(),
  })
  .strict()

/** The validated current-shape config (post-migration). */
export type CurrentConfig = z.infer<typeof CurrentConfigSchema>

/**
 * Upgrade an arbitrary parsed config object to the CURRENT schema shape
 * (plan §23, §20 M5 config migration).
 *
 * Migration is shape-only and additive: each step takes the prior version's
 * object and returns the next version's, filling new fields with sane defaults.
 * A config with no `configVersion` is treated as the pre-versioning "version 0"
 * shape and upgraded. The result is then validated by {@link CurrentConfigSchema};
 * an unmigratable/invalid config throws a clear `zod` error (caller surfaces it).
 *
 * Throws if `raw` is not a plain object.
 */
export function migrateConfig(raw: unknown): CurrentConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid config: expected a JSON object')
  }
  let obj = raw as Record<string, unknown>
  const version = typeof obj.configVersion === 'number' ? obj.configVersion : 0

  // Step 0 -> 1: the pre-versioning shape. Tolerate two legacy layouts that
  // existed before §23 was formalized and lift them into the nested blocks:
  //   - flat `{ dbPath, retentionMode }`
  //   - partially-nested `{ storage:{path}, retention:{mode} }` with no version
  // then stamp `configVersion: 1` and default the new `observability` block.
  if (version < 1) {
    obj = migrateV0ToV1(obj)
  }

  // Future steps append here as `if (version < N) obj = migrateV{N-1}ToV{N}(obj)`.

  return CurrentConfigSchema.parse(obj)
}

/** 0 -> 1: normalize legacy flat/partial shapes into the §23 nested template. */
function migrateV0ToV1(obj: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { configVersion: 1 }

  // storage.path: prefer nested, fall back to a legacy flat `dbPath`.
  const legacyPath =
    readNestedString(obj, 'storage', 'path') ??
    (typeof obj.dbPath === 'string' ? obj.dbPath : undefined)
  next.storage = { provider: 'sqlite', ...(legacyPath ? { path: legacyPath } : {}) }

  // retention.mode: prefer nested, fall back to a legacy flat `retentionMode`.
  const legacyMode =
    readNestedString(obj, 'retention', 'mode') ??
    (typeof obj.retentionMode === 'string' ? obj.retentionMode : undefined)
  if (legacyMode !== undefined) {
    next.retention = { mode: legacyMode }
  }

  // observability did not exist pre-v1; default to OFF.
  next.observability = { level: DEFAULT_OBSERVABILITY.level }

  // Carry forward provider blocks untouched; the schema validates them.
  if (obj.llm !== undefined) {
    next.llm = obj.llm
  }
  if (obj.embeddings !== undefined) {
    next.embeddings = obj.embeddings
  }
  return next
}

/** Read `obj[outer][inner]` when it is a string, else undefined. */
function readNestedString(
  obj: Record<string, unknown>,
  outer: string,
  inner: string,
): string | undefined {
  const block = obj[outer]
  if (typeof block === 'object' && block !== null) {
    const value = (block as Record<string, unknown>)[inner]
    if (typeof value === 'string') {
      return value
    }
  }
  return undefined
}

/** Collapse a persisted `model: null` (the §23 template default) to unset. */
function providerFromCurrent(
  block: z.infer<typeof ProviderConfigSchema> | undefined,
): { provider: EmbeddingProvider; baseUrl?: string; model?: string; apiKey?: string } | undefined {
  if (!block) {
    return undefined
  }
  const out: { provider: EmbeddingProvider; baseUrl?: string; model?: string; apiKey?: string } = {
    provider: block.provider,
  }
  if (block.baseUrl !== undefined) {
    out.baseUrl = block.baseUrl
  }
  if (block.model != null) {
    out.model = block.model
  }
  if (block.apiKey !== undefined) {
    out.apiKey = block.apiKey
  }
  return out
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Path to the on-disk config file (JSON). */
  path: string
  /** Process env used to resolve observability when the file omits it. */
  env?: NodeJS.ProcessEnv
}

/**
 * Load, migrate, and resolve an on-disk config into a runtime {@link NaruConfig}
 * (plan §23, §20 M5).
 *
 * Reads the JSON file, runs {@link migrateConfig} to upgrade any older shape to
 * the current schema, validates it, then maps the validated nested blocks onto
 * the flat runtime config (expanding `~`/relative DB paths, applying §23
 * defaults for anything omitted). Throws a clear error on missing/unreadable
 * files, invalid JSON, or a config that fails validation after migration.
 */
export function loadConfig(options: LoadConfigOptions): NaruConfig {
  let text: string
  try {
    text = readFileSync(options.path, 'utf8')
  } catch (cause) {
    throw new Error(`Cannot read config file at ${options.path}`, { cause })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`Invalid JSON in config file at ${options.path}`, { cause })
  }

  const current = migrateConfig(parsed)
  return fromCurrentConfig(current, options.env)
}

/** Map a validated current-shape config onto the flat runtime {@link NaruConfig}. */
function fromCurrentConfig(current: CurrentConfig, env?: NodeJS.ProcessEnv): NaruConfig {
  const rawPath = current.storage?.path ?? defaultDbPath()
  const config: NaruConfig = {
    configVersion: current.configVersion,
    dbPath: expandPath(rawPath),
    retentionMode: current.retention?.mode ?? DEFAULT_RETENTION,
    observability: current.observability
      ? { level: current.observability.level }
      : resolveObservabilityFromEnv(env),
  }
  const llm = providerFromCurrent(current.llm)
  if (llm) {
    config.llm = llm as LlmConfig
  }
  const embeddings = providerFromCurrent(current.embeddings)
  if (embeddings) {
    config.embeddings = embeddings
  }
  return config
}

/** Observability from env (`NARU_LOG`) when the config file omits the block. */
function resolveObservabilityFromEnv(env?: NodeJS.ProcessEnv): ObservabilityConfig {
  const raw = (env ?? process.env).NARU_LOG?.toLowerCase().trim()
  if (raw === 'quiet' || raw === 'verbose' || raw === 'off') {
    return { level: raw }
  }
  return DEFAULT_OBSERVABILITY
}

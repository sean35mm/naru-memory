/** A single forward-only schema migration. */
export interface Migration {
  /** Zero-padded, lexicographically sortable version, e.g. "0001". */
  version: string
  name: string
  sql: string
}

/**
 * Canonical + derived schema for the SQLite store (plan §11).
 *
 * Canonical tables (authoritative, exported/backed up): scopes, episodes,
 * entities, facts, evidence, edges, supersessions. Derived/seam tables:
 * embeddings, index_state, and the FTS5 virtual tables (rebuildable from
 * canonical, plan §11.11, §12.2). `schema_migrations` tracks applied versions.
 *
 * Column names are snake_case and match the plan's candidate columns exactly.
 */
const INIT_SQL = `
-- 11.1 schema_migrations -------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 11.2 scopes ------------------------------------------------------------
CREATE TABLE scopes (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  key             TEXT NOT NULL UNIQUE,
  parent_scope_id TEXT REFERENCES scopes(id),
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_scopes_type_key ON scopes(type, key);
CREATE INDEX idx_scopes_parent ON scopes(parent_scope_id);

-- 11.3 episodes ----------------------------------------------------------
CREATE TABLE episodes (
  id             TEXT PRIMARY KEY,
  scope_id       TEXT NOT NULL REFERENCES scopes(id),
  source_type    TEXT NOT NULL,
  source_ref     TEXT,
  source_hash    TEXT NOT NULL,
  hmac_hash      TEXT,
  retention_mode TEXT NOT NULL,
  redacted_text  TEXT,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  observed_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_episodes_scope_observed ON episodes(scope_id, observed_at);
CREATE INDEX idx_episodes_source_hash ON episodes(source_hash);
CREATE UNIQUE INDEX idx_episodes_scope_source_hash ON episodes(scope_id, source_hash);

-- 11.4 entities ----------------------------------------------------------
CREATE TABLE entities (
  id             TEXT PRIMARY KEY,
  scope_id       TEXT REFERENCES scopes(id),
  type           TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  aliases_json   TEXT NOT NULL DEFAULT '[]',
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_entities_scope_normkey ON entities(scope_id, normalized_key);
CREATE INDEX idx_entities_type_normkey ON entities(type, normalized_key);

-- 11.5 facts -------------------------------------------------------------
CREATE TABLE facts (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL REFERENCES scopes(id),
  subject_entity_id TEXT REFERENCES entities(id),
  predicate         TEXT NOT NULL,
  object_entity_id  TEXT REFERENCES entities(id),
  object_value      TEXT,
  statement         TEXT NOT NULL,
  statement_hash    TEXT NOT NULL,
  confidence        REAL NOT NULL,
  status            TEXT NOT NULL,
  valid_from        TEXT,
  valid_to          TEXT,
  observed_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  metadata_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_facts_scope_status ON facts(scope_id, status);
CREATE INDEX idx_facts_scope_predicate ON facts(scope_id, predicate);
CREATE INDEX idx_facts_subject ON facts(subject_entity_id);
CREATE INDEX idx_facts_object ON facts(object_entity_id);
CREATE INDEX idx_facts_statement_hash ON facts(statement_hash);
CREATE INDEX idx_facts_valid ON facts(valid_from, valid_to);
CREATE INDEX idx_facts_observed ON facts(observed_at);
-- At most one ACTIVE fact per (scope, statement_hash): exact-hash dedupe
-- backstop (plan §13.5) that also blocks a superseded statement from being
-- resurrected as a second active row (plan §13.6/§14.3).
CREATE UNIQUE INDEX idx_facts_active_hash ON facts(scope_id, statement_hash) WHERE status = 'active';

-- 11.6 evidence ----------------------------------------------------------
CREATE TABLE evidence (
  id                TEXT PRIMARY KEY,
  fact_id           TEXT NOT NULL REFERENCES facts(id),
  episode_id        TEXT NOT NULL REFERENCES episodes(id),
  span_start        INTEGER,
  span_end          INTEGER,
  redacted_quote    TEXT,
  quote_hash        TEXT,
  extractor_name    TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_evidence_fact ON evidence(fact_id);
CREATE INDEX idx_evidence_episode ON evidence(episode_id);
CREATE INDEX idx_evidence_quote_hash ON evidence(quote_hash);

-- 11.7 edges -------------------------------------------------------------
CREATE TABLE edges (
  id            TEXT PRIMARY KEY,
  scope_id      TEXT NOT NULL REFERENCES scopes(id),
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  confidence    REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_edges_source ON edges(scope_id, source_type, source_id);
CREATE INDEX idx_edges_target ON edges(scope_id, target_type, target_id);
CREATE INDEX idx_edges_predicate ON edges(scope_id, predicate);

-- 11.8 supersessions -----------------------------------------------------
CREATE TABLE supersessions (
  id           TEXT PRIMARY KEY,
  old_fact_id  TEXT NOT NULL REFERENCES facts(id),
  new_fact_id  TEXT NOT NULL REFERENCES facts(id),
  reason       TEXT,
  confidence   REAL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_supersessions_old ON supersessions(old_fact_id);
CREATE INDEX idx_supersessions_new ON supersessions(new_fact_id);
CREATE UNIQUE INDEX idx_supersessions_old_new ON supersessions(old_fact_id, new_fact_id);

-- 11.9 embeddings (seam; types only this milestone) ----------------------
CREATE TABLE embeddings (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  dimension   INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  status      TEXT NOT NULL,
  vector_ref  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  error       TEXT
);
CREATE INDEX idx_embeddings_target ON embeddings(target_type, target_id);
CREATE INDEX idx_embeddings_provider ON embeddings(provider, model, dimension);
CREATE INDEX idx_embeddings_status ON embeddings(status);

-- 11.10 index_state ------------------------------------------------------
CREATE TABLE index_state (
  index_name       TEXT PRIMARY KEY,
  index_version    TEXT NOT NULL,
  source_watermark TEXT,
  source_hash      TEXT,
  status           TEXT NOT NULL,
  last_rebuilt_at  TEXT,
  error            TEXT,
  metadata_json    TEXT NOT NULL DEFAULT '{}'
);

-- 11.11 FTS5 virtual tables (derived, rebuildable) -----------------------
CREATE VIRTUAL TABLE facts_fts USING fts5(
  statement,
  predicate,
  entity_text,
  scope_key UNINDEXED,
  fact_id UNINDEXED
);

CREATE VIRTUAL TABLE entities_fts USING fts5(
  canonical_name,
  aliases,
  entity_id UNINDEXED
);
`

/**
 * Vector storage for fact embeddings (plan §11.9, §12.2, M3 vector retrieval).
 *
 * Additive migration: a `fact_vectors` side table holding one Float32 vector
 * BLOB per fact (1:1, `fact_id` PK). Vectors are derived/rebuildable state, kept
 * separate from the canonical `facts` row and from the `embeddings` state table
 * (which §11.9 keeps for lifecycle/freshness). KNN is brute-force cosine in JS
 * over scope-filtered candidates, so the scope filter lives in the SELECT that
 * picks candidate vectors — never rank-then-filter (plan §9.4, §18.3).
 *
 * `ON DELETE CASCADE` so a privacy purge of a fact also drops its vector even if
 * the higher-level forget path does not explicitly unindex it (plan §18.2). The
 * `provider`/`model`/`dimension` columns let capability detection and KNN reject
 * mismatched-dimension vectors and let reindex target a specific provider.
 */
const VECTORS_SQL = `
-- fact_vectors (derived, rebuildable; plan §11.9, §12.2) -----------------
CREATE TABLE IF NOT EXISTS fact_vectors (
  fact_id     TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  dimension   INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  source_hash TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_vectors_provider ON fact_vectors(provider, model, dimension);
`

/** Ordered list of forward migrations applied by {@link runMigrations}. */
export const MIGRATIONS: Migration[] = [
  {
    version: '0001',
    name: 'init',
    sql: INIT_SQL,
  },
  {
    version: '0002',
    name: 'vectors',
    sql: VECTORS_SQL,
  },
]

/**
 * The newest migration version, i.e. the canonical schema version a freshly
 * opened store is at (plan §19 export `schemaVersion`).
 *
 * This is the single source of truth for the version stamped into a portable
 * bundle and validated on import: a bundle whose `schemaVersion` is unknown to
 * the importing store (e.g. produced by a NEWER Naru with migrations this build
 * has never seen) is rejected rather than silently mis-imported. Derived from
 * {@link MIGRATIONS} so it advances automatically when a migration is appended.
 */
export function latestSchemaVersion(): string {
  const last = MIGRATIONS[MIGRATIONS.length - 1]
  if (!last) {
    throw new Error('no migrations defined')
  }
  return last.version
}

/** Every migration version this build knows how to produce/consume. */
export function knownSchemaVersions(): string[] {
  return MIGRATIONS.map((m) => m.version)
}

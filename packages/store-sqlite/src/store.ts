import type Database from 'better-sqlite3'
import { type BackupResult, backupDatabase } from './backup'
import { type OpenDatabaseOptions, openDatabase } from './db'
import { assertSchemaCurrent, runMigrations } from './migrate'
import {
  EdgesRepository,
  EntitiesRepository,
  EpisodesRepository,
  EvidenceRepository,
  FactsRepository,
  IndexStateRepository,
  IntegrityRepository,
  ScopesRepository,
  SupersessionsRepository,
  VectorRepository,
} from './repositories'

/** A `facts` row joined to its subject/object entity names for FTS rebuild. */
interface FactFtsSourceRow {
  fact_id: string
  statement: string
  predicate: string
  object_value: string | null
  scope_key: string
  subject_name: string | null
  object_name: string | null
}

/**
 * Canonical SQLite store (plan §12.1): opens the DB, runs migrations, and
 * exposes one repository per table plus a transaction helper.
 *
 * Construct via {@link Store.open}. All repositories share the single
 * `better-sqlite3` connection (synchronous API — no async/await).
 */
export class Store {
  readonly scopes: ScopesRepository
  readonly episodes: EpisodesRepository
  readonly entities: EntitiesRepository
  readonly facts: FactsRepository
  readonly evidence: EvidenceRepository
  readonly edges: EdgesRepository
  readonly supersessions: SupersessionsRepository
  readonly indexState: IndexStateRepository
  readonly integrity: IntegrityRepository
  readonly vectors: VectorRepository

  private constructor(readonly db: Database.Database) {
    this.scopes = new ScopesRepository(db)
    this.episodes = new EpisodesRepository(db)
    this.entities = new EntitiesRepository(db)
    this.facts = new FactsRepository(db)
    this.evidence = new EvidenceRepository(db)
    this.edges = new EdgesRepository(db)
    this.supersessions = new SupersessionsRepository(db)
    this.indexState = new IndexStateRepository(db)
    this.integrity = new IntegrityRepository(db)
    this.vectors = new VectorRepository(db)
  }

  /**
   * Open the store: connect, apply pragmas, prepare the schema, build repos.
   *
   * For a normal (writable) open this runs migrations. For a READ-ONLY open
   * (`readonly: true`, plan §12.3 read-only admin ops) it never writes: the
   * connection is opened read-only and {@link assertSchemaCurrent} VALIDATES the
   * schema instead of migrating it, throwing a clear error for an uninitialized
   * or behind-schema DB rather than silently creating tables / applying
   * migrations on a second writer behind a live server.
   */
  static open(options: OpenDatabaseOptions): Store {
    const db = openDatabase(options)
    if (options.readonly) {
      assertSchemaCurrent(db)
    } else {
      runMigrations(db)
    }
    return new Store(db)
  }

  /**
   * Run `fn` inside a single SQLite transaction (plan §12.3 transactional
   * writes). Commits on return, rolls back if `fn` throws. Synchronous.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /**
   * Clear and rebuild both FTS tables from canonical rows (used by core
   * reindex, plan §12.2). For `facts_fts`, `entity_text` is reconstructed by
   * joining each fact to its subject/object entity names plus its literal
   * `object_value`, and `scope_key` from the owning scope.
   */
  rebuildFts(): void {
    this.transaction(() => {
      this.entities.rebuildFts()
      this.rebuildFactsFts()
    })
  }

  private rebuildFactsFts(): void {
    this.facts.clearFts()
    // LEFT JOIN to scopes (not INNER): a canonical fact whose `scope_id`
    // references a MISSING scope (corruption from tampering / a partial restore /
    // a write-path bug) must STILL be indexed so it remains searchable and
    // `checkIntegrity`'s facts_fts_missing probe can converge — an INNER JOIN
    // would silently drop it from FTS forever (plan §22 index staleness, §12.2).
    // When the scope is missing, fall back to the raw `scope_id` as the FTS
    // `scope_key` so the row carries a non-null, deterministic key (the orphan is
    // re-homed under a recovered scope by integrity repair).
    const rows = this.db
      .prepare(
        `SELECT f.id AS fact_id,
                f.statement AS statement,
                f.predicate AS predicate,
                f.object_value AS object_value,
                COALESCE(s.key, f.scope_id) AS scope_key,
                subj.canonical_name AS subject_name,
                obj.canonical_name AS object_name
           FROM facts f
           LEFT JOIN scopes s ON s.id = f.scope_id
           LEFT JOIN entities subj ON subj.id = f.subject_entity_id
           LEFT JOIN entities obj ON obj.id = f.object_entity_id`,
      )
      .all() as FactFtsSourceRow[]
    const insert = this.db.prepare(
      `INSERT INTO facts_fts (fact_id, statement, predicate, entity_text, scope_key)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      const entityText = [row.subject_name, row.object_name, row.object_value]
        .filter((v): v is string => v != null && v.length > 0)
        .join(' ')
      insert.run(row.fact_id, row.statement, row.predicate, entityText, row.scope_key)
    }
  }

  /**
   * Write a consistent, standalone snapshot of this DB to `destPath` using
   * `VACUUM INTO` (plan §20 M5 backup, §12.3). Read-only w.r.t. the live DB;
   * the snapshot is a self-contained `.db` (no WAL/SHM sidecars) chmod'd 0600.
   * The destination must not already exist. Returns the path + byte size.
   */
  backupTo(destPath: string): BackupResult {
    return backupDatabase(this.db, destPath)
  }

  /** Close the underlying connection. */
  close(): void {
    this.db.close()
  }
}

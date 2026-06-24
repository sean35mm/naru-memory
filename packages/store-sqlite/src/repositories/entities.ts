import { type Entity, type EntityType, newEntityId, nowIso } from '@naru/schema'
import type Database from 'better-sqlite3'
import { parseRecord, parseStringArray, stringifyRecord, stringifyStringArray } from './json'

/** An `entities` table row in snake_case column form. */
interface EntityRow {
  id: string
  scope_id: string | null
  type: string
  canonical_name: string
  normalized_key: string
  aliases_json: string
  metadata_json: string
  created_at: string
  updated_at: string
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    scopeId: row.scope_id,
    type: row.type as EntityType,
    canonicalName: row.canonical_name,
    normalizedKey: row.normalized_key,
    aliases: parseStringArray(row.aliases_json),
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Normalize an entity name into its matching key (plan §13.4):
 * NFC, lowercase, trim, collapse internal whitespace.
 */
export function normalizeEntityKey(name: string): string {
  return name.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ')
}

/** Input for get-or-create of an entity. */
export interface EnsureEntityInput {
  /** Owning scope; `null` only for explicitly promoted global entities (§11.4). */
  scopeId: string | null
  type: EntityType
  canonicalName: string
  /** Defaults to `normalizeEntityKey(canonicalName)`. */
  normalizedKey?: string
  aliases?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Persistence for canonical entities (plan §11.4), keeping `entities_fts` in
 * sync on insert/update/delete so entity text retrieval is rebuildable.
 */
export class EntitiesRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Get-or-create an entity by `(scopeId, normalizedKey, type)`. Dedupe is
   * scope-aware (plan §13.4): two entities with the same normalized key in
   * different scopes are distinct rows.
   */
  ensure(input: EnsureEntityInput): Entity {
    const normalizedKey = input.normalizedKey ?? normalizeEntityKey(input.canonicalName)
    const existing = this.findByKey(input.scopeId, normalizedKey, input.type)
    if (existing) {
      return existing
    }
    const now = nowIso()
    const entity: Entity = {
      id: newEntityId(),
      scopeId: input.scopeId,
      type: input.type,
      canonicalName: input.canonicalName,
      normalizedKey,
      aliases: input.aliases ?? [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.insertRow(entity)
    this.indexEntity(entity)
    return entity
  }

  /**
   * Insert a fully-formed entity (caller supplies id/timestamps) and index it
   * into `entities_fts`, bypassing the get-or-create dedupe of {@link ensure}.
   * Used by bundle import (plan §19) to preserve a portable entity id; the
   * caller is responsible for first checking that the id/key does not collide.
   */
  insertRaw(entity: Entity): Entity {
    this.insertRow(entity)
    this.indexEntity(entity)
    return entity
  }

  /** All entities, across every scope plus promoted globals (bundle export, §19). */
  listAll(): Entity[] {
    const rows = this.db.prepare('SELECT * FROM entities ORDER BY created_at').all() as EntityRow[]
    return rows.map(rowToEntity)
  }

  private insertRow(entity: Entity): void {
    this.db
      .prepare(
        `INSERT INTO entities
           (id, scope_id, type, canonical_name, normalized_key, aliases_json, metadata_json, created_at, updated_at)
         VALUES
           (@id, @scopeId, @type, @canonicalName, @normalizedKey, @aliasesJson, @metadataJson, @createdAt, @updatedAt)`,
      )
      .run({
        id: entity.id,
        scopeId: entity.scopeId,
        type: entity.type,
        canonicalName: entity.canonicalName,
        normalizedKey: entity.normalizedKey,
        aliasesJson: stringifyStringArray(entity.aliases),
        metadataJson: stringifyRecord(entity.metadata),
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      })
  }

  /** Find a single entity by its scope-aware dedupe key. */
  findByKey(scopeId: string | null, normalizedKey: string, type: EntityType): Entity | undefined {
    const sql =
      scopeId === null
        ? 'SELECT * FROM entities WHERE scope_id IS NULL AND normalized_key = ? AND type = ?'
        : 'SELECT * FROM entities WHERE scope_id = ? AND normalized_key = ? AND type = ?'
    const params = scopeId === null ? [normalizedKey, type] : [scopeId, normalizedKey, type]
    const row = this.db.prepare(sql).get(...params) as EntityRow | undefined
    return row ? rowToEntity(row) : undefined
  }

  getById(id: string): Entity | undefined {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
      | EntityRow
      | undefined
    return row ? rowToEntity(row) : undefined
  }

  listByScope(scopeId: string | null): Entity[] {
    const rows =
      scopeId === null
        ? (this.db
            .prepare('SELECT * FROM entities WHERE scope_id IS NULL ORDER BY created_at')
            .all() as EntityRow[])
        : (this.db
            .prepare('SELECT * FROM entities WHERE scope_id = ? ORDER BY created_at')
            .all(scopeId) as EntityRow[])
    return rows.map(rowToEntity)
  }

  deleteById(id: string): void {
    this.unindexEntity(id)
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(id)
  }

  /** Insert an entity's row into `entities_fts` (canonical_name + aliases). */
  indexEntity(entity: Entity): void {
    this.db
      .prepare('INSERT INTO entities_fts (entity_id, canonical_name, aliases) VALUES (?, ?, ?)')
      .run(entity.id, entity.canonicalName, entity.aliases.join(' '))
  }

  /** Remove an entity's row from `entities_fts`. */
  unindexEntity(entityId: string): void {
    this.db.prepare('DELETE FROM entities_fts WHERE entity_id = ?').run(entityId)
  }

  /** Drop and rebuild `entities_fts` from canonical rows (used by reindex). */
  rebuildFts(): void {
    this.db.exec('DELETE FROM entities_fts')
    const rows = this.db.prepare('SELECT * FROM entities').all() as EntityRow[]
    const insert = this.db.prepare(
      'INSERT INTO entities_fts (entity_id, canonical_name, aliases) VALUES (?, ?, ?)',
    )
    for (const row of rows) {
      insert.run(row.id, row.canonical_name, parseStringArray(row.aliases_json).join(' '))
    }
  }
}

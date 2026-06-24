import { type Scope, type ScopeType, newScopeId, nowIso, scopeKey } from '@naru/schema'
import type Database from 'better-sqlite3'
import { parseRecord, stringifyRecord } from './json'

/** A `scopes` table row in snake_case column form. */
interface ScopeRow {
  id: string
  type: string
  name: string
  key: string
  parent_scope_id: string | null
  metadata_json: string
  created_at: string
  updated_at: string
}

function rowToScope(row: ScopeRow): Scope {
  return {
    id: row.id,
    type: row.type as ScopeType,
    name: row.name,
    key: row.key,
    parentScopeId: row.parent_scope_id,
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Input for creating a scope; `key` defaults to `scopeKey(type, keyPart)`. */
export interface EnsureScopeInput {
  type: ScopeType
  /** Key part used to build the unique `scopeKey(type, keyPart)`. */
  keyPart: string
  /** Display name; defaults to `keyPart`. */
  name?: string
  parentScopeId?: string | null
  metadata?: Record<string, unknown>
}

/** Persistence for scope nodes (plan §11.2). */
export class ScopesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Get-or-create a scope by `(type, keyPart)`, returning the canonical row. */
  ensure(input: EnsureScopeInput): Scope {
    // `global` is a query-time read alias, never a stored row or write target
    // (plan §9.1). Refuse at the persistence layer so no transport can create
    // a `global` scope row regardless of upstream input validation.
    if (input.type === 'global') {
      throw new Error('cannot create a "global" scope: global is a read alias, not a stored scope')
    }
    const key = scopeKey(input.type, input.keyPart)
    const existing = this.getByKey(key)
    if (existing) {
      return existing
    }
    const now = nowIso()
    const scope: Scope = {
      id: newScopeId(),
      type: input.type,
      name: input.name ?? input.keyPart,
      key,
      parentScopeId: input.parentScopeId ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO scopes (id, type, name, key, parent_scope_id, metadata_json, created_at, updated_at)
         VALUES (@id, @type, @name, @key, @parentScopeId, @metadataJson, @createdAt, @updatedAt)`,
      )
      .run({
        id: scope.id,
        type: scope.type,
        name: scope.name,
        key: scope.key,
        parentScopeId: scope.parentScopeId,
        metadataJson: stringifyRecord(scope.metadata),
        createdAt: scope.createdAt,
        updatedAt: scope.updatedAt,
      })
    return scope
  }

  /**
   * Insert a fully-formed scope (caller supplies id/key/timestamps), bypassing
   * the get-or-create of {@link ensure}. Used by bundle import (plan §19) to
   * preserve a portable scope id. Still refuses a `global` scope (a read alias,
   * never a stored row — plan §9.1); the caller must check for a key collision
   * first since `key` is unique.
   */
  insertRaw(scope: Scope): Scope {
    if (scope.type === 'global') {
      throw new Error('cannot create a "global" scope: global is a read alias, not a stored scope')
    }
    this.db
      .prepare(
        `INSERT INTO scopes (id, type, name, key, parent_scope_id, metadata_json, created_at, updated_at)
         VALUES (@id, @type, @name, @key, @parentScopeId, @metadataJson, @createdAt, @updatedAt)`,
      )
      .run({
        id: scope.id,
        type: scope.type,
        name: scope.name,
        key: scope.key,
        parentScopeId: scope.parentScopeId,
        metadataJson: stringifyRecord(scope.metadata),
        createdAt: scope.createdAt,
        updatedAt: scope.updatedAt,
      })
    return scope
  }

  getById(id: string): Scope | undefined {
    const row = this.db.prepare('SELECT * FROM scopes WHERE id = ?').get(id) as ScopeRow | undefined
    return row ? rowToScope(row) : undefined
  }

  getByKey(key: string): Scope | undefined {
    const row = this.db.prepare('SELECT * FROM scopes WHERE key = ?').get(key) as
      | ScopeRow
      | undefined
    return row ? rowToScope(row) : undefined
  }

  list(): Scope[] {
    const rows = this.db.prepare('SELECT * FROM scopes ORDER BY created_at').all() as ScopeRow[]
    return rows.map(rowToScope)
  }
}

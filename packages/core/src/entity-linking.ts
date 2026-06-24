import { type Entity, type EntityType, normalizeText } from '@naru/schema'
import { type Store, normalizeEntityKey } from '@naru/store-sqlite'

/** A deterministically extracted entity candidate (plan §13.4). */
export interface ExtractedEntity {
  name: string
  type: EntityType
}

/**
 * Normalize an entity name to its matching key (plan §13.4): NFC +
 * whitespace-collapse (via `normalizeText`) + lowercase. Delegates to the
 * store's `normalizeEntityKey` so core extraction and store dedupe agree.
 */
export function normalizeEntityName(name: string): string {
  return normalizeEntityKey(name)
}

const QUOTED = /"([^"]{2,})"|'([^']{2,})'/g
// file-like tokens: a.b, src/x.ts, foo/bar.json
const FILE_LIKE = /\b[\w./-]*[\w-]+\.[A-Za-z0-9]{1,8}\b/g
const PATH_LIKE = /\b(?:[\w-]+\/){1,}[\w.-]+\b/g
// CamelCase / PascalCase identifiers: FooBar, useState, ScopeService
const CAMEL_CASE = /\b[A-Za-z]+[a-z]+[A-Z][A-Za-z]*\b/g
// Capitalized standalone tokens (proper nouns): "Vitest", "React"
const CAPITALIZED = /\b[A-Z][a-zA-Z0-9]{2,}\b/g

// Common known dev tools — typed as `tool` rather than generic `concept`.
const KNOWN_TOOLS = new Set([
  'jest',
  'vitest',
  'eslint',
  'biome',
  'prettier',
  'webpack',
  'vite',
  'rollup',
  'esbuild',
  'tsx',
  'typescript',
  'pnpm',
  'npm',
  'yarn',
  'docker',
  'git',
  'github',
  'sqlite',
  'postgres',
  'redis',
])

/** Classify a raw token into an entity type using conservative heuristics. */
function classify(name: string): EntityType {
  const trimmed = name.trim()
  if (/[./]/.test(trimmed) && /\.[A-Za-z0-9]{1,8}$/.test(trimmed)) {
    return 'file'
  }
  if (trimmed.includes('/')) {
    return 'file'
  }
  if (KNOWN_TOOLS.has(trimmed.toLowerCase())) {
    return 'tool'
  }
  return 'concept'
}

/**
 * Deterministic, conservative entity extraction for Milestone 1 (plan §13.3,
 * §13.4). No LLM. Pulls: quoted phrases, file-like and path-like tokens,
 * CamelCase/PascalCase identifiers, and capitalized proper-noun tokens.
 *
 * Results are deduped by normalized key (first occurrence wins for the
 * surface form/type). Order of appearance is preserved.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const found = new Map<string, ExtractedEntity>()

  const add = (raw: string, type?: EntityType): void => {
    const name = normalizeText(raw)
    if (name.length < 2) {
      return
    }
    const key = normalizeEntityName(name)
    if (key.length < 2 || found.has(key)) {
      return
    }
    found.set(key, { name, type: type ?? classify(name) })
  }

  for (const m of text.matchAll(QUOTED)) {
    add(m[1] ?? m[2] ?? '')
  }
  for (const m of text.matchAll(FILE_LIKE)) {
    add(m[0], 'file')
  }
  for (const m of text.matchAll(PATH_LIKE)) {
    add(m[0], 'file')
  }
  for (const m of text.matchAll(CAMEL_CASE)) {
    add(m[0])
  }
  for (const m of text.matchAll(CAPITALIZED)) {
    add(m[0])
  }

  return [...found.values()]
}

/**
 * Link extracted entity names to canonical entity rows within `scopeId`
 * (plan §13.4). Scope-aware get-or-create via `entities.ensure`; the same
 * normalized key in a different scope is a distinct row.
 */
export function linkEntities(store: Store, scopeId: string, entities: ExtractedEntity[]): Entity[] {
  const linked: Entity[] = []
  const seen = new Set<string>()
  for (const e of entities) {
    const normalizedKey = normalizeEntityName(e.name)
    const dedupeKey = `${e.type}:${normalizedKey}`
    if (seen.has(dedupeKey)) {
      continue
    }
    seen.add(dedupeKey)
    linked.push(
      store.entities.ensure({
        scopeId,
        type: e.type,
        canonicalName: e.name,
        normalizedKey,
      }),
    )
  }
  return linked
}

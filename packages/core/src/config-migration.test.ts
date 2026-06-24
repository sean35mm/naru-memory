import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_VERSION, loadConfig, migrateConfig } from './config'

/**
 * Config versioning + migration (plan §23, §20 M5).
 *
 * An older-shaped config must migrate cleanly to the current schema with sane
 * defaults; an invalid config must error clearly. Tests use a temp dir — never
 * a real user config path.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'naru-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(name: string, value: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value), 'utf8')
  return path
}

describe('migrateConfig', () => {
  it('upgrades a legacy flat (version 0) config to the current shape with defaults', () => {
    // The pre-versioning shape: flat dbPath + retentionMode, no configVersion,
    // no observability block.
    const legacy = { dbPath: '/tmp/old-naru.db', retentionMode: 'minimal' }
    const migrated = migrateConfig(legacy)

    expect(migrated.configVersion).toBe(CONFIG_VERSION)
    expect(migrated.storage?.path).toBe('/tmp/old-naru.db')
    expect(migrated.storage?.provider).toBe('sqlite')
    expect(migrated.retention?.mode).toBe('minimal')
    // observability gains a default OFF block it never had.
    expect(migrated.observability?.level).toBe('off')
  })

  it('upgrades a partially-nested version-0 config (no configVersion)', () => {
    const legacy = {
      storage: { path: '/tmp/n.db' },
      retention: { mode: 'redacted' },
      llm: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: null },
    }
    const migrated = migrateConfig(legacy)
    expect(migrated.configVersion).toBe(CONFIG_VERSION)
    expect(migrated.retention?.mode).toBe('redacted')
    expect(migrated.llm?.provider).toBe('ollama')
    // A persisted model:null (the §23 template default) round-trips through the
    // schema as null and is collapsed to "unset" only at loadConfig time.
    expect(migrated.llm?.model).toBeNull()
  })

  it('passes a current-version config through unchanged', () => {
    const current = {
      configVersion: CONFIG_VERSION,
      storage: { provider: 'sqlite', path: '/tmp/x.db' },
      retention: { mode: 'none' },
      observability: { level: 'verbose' },
    }
    const migrated = migrateConfig(current)
    expect(migrated.configVersion).toBe(CONFIG_VERSION)
    expect(migrated.observability?.level).toBe('verbose')
    expect(migrated.retention?.mode).toBe('none')
  })

  it('throws clearly when the raw config is not an object', () => {
    expect(() => migrateConfig('not-an-object')).toThrow(/expected a JSON object/i)
    expect(() => migrateConfig([1, 2, 3])).toThrow(/expected a JSON object/i)
  })

  it('throws a clear validation error for an invalid retention mode', () => {
    expect(() =>
      migrateConfig({ configVersion: CONFIG_VERSION, retention: { mode: 'bogus' } }),
    ).toThrow()
  })

  it('rejects unknown top-level keys (strict schema, fail loud)', () => {
    expect(() => migrateConfig({ configVersion: CONFIG_VERSION, totallyUnknown: true })).toThrow()
  })
})

describe('loadConfig', () => {
  it('loads + migrates a legacy on-disk config into a runtime NaruConfig', () => {
    const path = writeConfig('legacy.json', {
      dbPath: '/tmp/legacy.db',
      retentionMode: 'minimal',
    })
    const config = loadConfig({ path, env: {} })

    expect(config.configVersion).toBe(CONFIG_VERSION)
    expect(config.dbPath).toBe('/tmp/legacy.db')
    expect(config.retentionMode).toBe('minimal')
    expect(config.observability.level).toBe('off')
  })

  it('collapses a persisted llm.model:null to unset on the runtime config', () => {
    const path = writeConfig('null-model.json', {
      configVersion: CONFIG_VERSION,
      storage: { provider: 'sqlite', path: '/tmp/n.db' },
      llm: { provider: 'ollama', model: null },
      embeddings: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: null },
    })
    const config = loadConfig({ path, env: {} })
    expect(config.llm?.provider).toBe('ollama')
    expect(config.llm?.model).toBeUndefined()
    expect(config.embeddings?.baseUrl).toBe('http://127.0.0.1:11434')
    expect(config.embeddings?.model).toBeUndefined()
  })

  it('falls back to NARU_LOG env for observability when the file omits it', () => {
    const path = writeConfig('no-obs.json', {
      dbPath: '/tmp/x.db',
      retentionMode: 'redacted',
    })
    // Legacy migration always stamps an explicit observability block, so a
    // migrated file pins level to OFF regardless of env — assert that contract.
    const config = loadConfig({ path, env: { NARU_LOG: 'verbose' } })
    expect(config.observability.level).toBe('off')
  })

  it('throws a clear error for malformed JSON', () => {
    const path = join(dir, 'broken.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(() => loadConfig({ path, env: {} })).toThrow(/invalid json/i)
  })

  it('throws a clear error for a missing file', () => {
    expect(() => loadConfig({ path: join(dir, 'nope.json'), env: {} })).toThrow(
      /cannot read config file/i,
    )
  })
})

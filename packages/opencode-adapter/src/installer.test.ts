import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NARU_PLUGIN_ID,
  OPENCODE_CONFIG_FILENAME,
  OWNERSHIP_KEY,
  install,
  uninstall,
} from './installer'

/**
 * OpenCode adapter installer/uninstaller smoke tests (plan §17.6, §21.5).
 *
 * Every case targets a mktemp config dir so a real `~/.config` is never
 * touched. They assert the safety contract: a marked, MCP-free plugin entry;
 * idempotent install (one owned entry on re-run); unrelated user config keys
 * preserved across BOTH install and uninstall; uninstall removes only owned
 * entries; uninstall on a clean dir is a no-op; and dry-run writes nothing.
 */

let configDir: string

/** Absolute path of the managed config file under the temp dir. */
function configPath(): string {
  return join(configDir, OPENCODE_CONFIG_FILENAME)
}

/** Read + parse the managed config file (throws if absent). */
function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>
}

/** Whether the managed config file exists on disk. */
function configExists(): boolean {
  try {
    statSync(configPath())
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'naru-opencode-installer-'))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('install (plan §17.6)', () => {
  it('writes a marked, MCP-free plugin entry into a fresh config dir', () => {
    const result = install({ configDir })

    expect(result.changed).toBe(true)
    expect(result.dryRun).toBe(false)
    expect(result.configPath).toBe(configPath())

    const config = readConfig()
    // The plugin is registered.
    expect(config.plugin).toEqual([NARU_PLUGIN_ID])
    // Ownership is marked so uninstall can be surgical.
    expect(config[OWNERSHIP_KEY]).toEqual({
      managed: true,
      by: NARU_PLUGIN_ID,
      plugins: [NARU_PLUGIN_ID],
    })
    // MCP is NEVER enabled by install (plan §17.2/§17.6).
    expect('mcp' in config).toBe(false)
  })

  it('creates the config file with restrictive 0600 permissions', () => {
    install({ configDir })
    const mode = statSync(configPath()).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('is idempotent: a second install leaves exactly one owned plugin entry', () => {
    const first = install({ configDir })
    expect(first.changed).toBe(true)

    const second = install({ configDir })
    expect(second.changed).toBe(false)
    expect(second.changes).toEqual([])

    const config = readConfig()
    expect(config.plugin).toEqual([NARU_PLUGIN_ID])
    expect((config[OWNERSHIP_KEY] as { plugins: string[] }).plugins).toEqual([NARU_PLUGIN_ID])
  })

  it('preserves a pre-existing unrelated user config key and plugin', () => {
    // A user already has config with their own setting and their own plugin.
    writeFileSync(
      configPath(),
      JSON.stringify({ theme: 'dark', plugin: ['user/their-plugin'] }, null, 2),
    )

    const result = install({ configDir })
    expect(result.changed).toBe(true)

    const config = readConfig()
    // Unrelated key untouched.
    expect(config.theme).toBe('dark')
    // The user's plugin is preserved; ours is appended.
    expect(config.plugin).toEqual(['user/their-plugin', NARU_PLUGIN_ID])
    // Only OUR entry is recorded as owned.
    expect((config[OWNERSHIP_KEY] as { plugins: string[] }).plugins).toEqual([NARU_PLUGIN_ID])
  })

  it('dry-run writes nothing but reports the plan', () => {
    const result = install({ configDir, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.changes.length).toBeGreaterThan(0)
    // Nothing was written.
    expect(configExists()).toBe(false)
  })

  it('echoes back projectDir when provided', () => {
    const result = install({ configDir, projectDir: '/tmp/some-project' })
    expect(result.projectDir).toBe('/tmp/some-project')
  })
})

describe('uninstall (plan §17.6)', () => {
  it('removes only owned entries and leaves user config intact', () => {
    // Seed user config, then install, then uninstall.
    writeFileSync(
      configPath(),
      JSON.stringify(
        { theme: 'dark', plugin: ['user/their-plugin'], mcp: { some: 'server' } },
        null,
        2,
      ),
    )
    install({ configDir })

    const result = uninstall({ configDir })
    expect(result.changed).toBe(true)

    const config = readConfig()
    // User config fully preserved.
    expect(config.theme).toBe('dark')
    expect(config.mcp).toEqual({ some: 'server' })
    // Our plugin removed; the user's plugin remains.
    expect(config.plugin).toEqual(['user/their-plugin'])
    // Ownership marker gone.
    expect(OWNERSHIP_KEY in config).toBe(false)
  })

  it('round-trips a fresh install back to no config keys we added', () => {
    install({ configDir })
    uninstall({ configDir })

    const config = readConfig()
    // The plugin array we created (now empty) is dropped, marker removed.
    expect('plugin' in config).toBe(false)
    expect(OWNERSHIP_KEY in config).toBe(false)
  })

  it('is a no-op on a clean dir (no file)', () => {
    const result = uninstall({ configDir })
    expect(result.changed).toBe(false)
    expect(result.changes).toEqual([])
    // It did not create a file.
    expect(configExists()).toBe(false)
  })

  it('is a no-op when config exists but has no Naru ownership marker', () => {
    writeFileSync(configPath(), JSON.stringify({ theme: 'dark', plugin: ['user/x'] }, null, 2))
    const result = uninstall({ configDir })
    expect(result.changed).toBe(false)

    const config = readConfig()
    expect(config.theme).toBe('dark')
    expect(config.plugin).toEqual(['user/x'])
  })

  it('is idempotent: uninstalling twice is clean and errors on neither', () => {
    install({ configDir })
    const first = uninstall({ configDir })
    expect(first.changed).toBe(true)
    const second = uninstall({ configDir })
    expect(second.changed).toBe(false)
    expect(second.changes).toEqual([])
  })

  it('dry-run writes nothing but reports the removal plan', () => {
    install({ configDir })
    const before = readConfig()

    const result = uninstall({ configDir, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.changes.length).toBeGreaterThan(0)

    // Config unchanged on disk.
    expect(readConfig()).toEqual(before)
  })
})

describe('non-string (tuple/object-form) plugin entries are preserved (plan §17.6)', () => {
  it('install preserves a user tuple-form plugin entry and its options', () => {
    // OpenCode's `plugin` schema allows the tuple form `[name, options]` and
    // object entries; install must not drop them.
    writeFileSync(
      configPath(),
      JSON.stringify(
        { plugin: ['user/x', ['opencode-bar', { key: 'val' }], { name: 'obj', opts: { a: 1 } }] },
        null,
        2,
      ),
    )

    install({ configDir })

    const config = readConfig()
    // Every original entry (string, tuple, object) is preserved IN PLACE; ours
    // is appended at the end.
    expect(config.plugin).toEqual([
      'user/x',
      ['opencode-bar', { key: 'val' }],
      { name: 'obj', opts: { a: 1 } },
      NARU_PLUGIN_ID,
    ])
    // We only own our own entry.
    expect((config[OWNERSHIP_KEY] as { plugins: string[] }).plugins).toEqual([NARU_PLUGIN_ID])
  })

  it('install→uninstall round-trip preserves an array of only non-string entries', () => {
    // Worst case: a user with ONLY a local object plugin. The plugin key must
    // survive the round-trip (never wiped because a string-filtered view was
    // empty).
    const userPlugin = [{ path: './local-plugin.ts' }]
    writeFileSync(configPath(), JSON.stringify({ plugin: userPlugin }, null, 2))

    install({ configDir })
    // After install: user object entry preserved, ours appended.
    expect(readConfig().plugin).toEqual([{ path: './local-plugin.ts' }, NARU_PLUGIN_ID])

    uninstall({ configDir })
    // After uninstall: ONLY our string entry removed; the user's object entry
    // (and thus the `plugin` key) survives intact.
    const config = readConfig()
    expect(config.plugin).toEqual(userPlugin)
    expect(OWNERSHIP_KEY in config).toBe(false)
  })

  it('uninstall removes only the owned STRING entry and keeps tuple/object entries', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ plugin: [['opencode-bar', { key: 'val' }], 'user/keep'] }, null, 2),
    )
    install({ configDir })
    uninstall({ configDir })

    const config = readConfig()
    // The tuple entry and the unrelated user string both remain; only ours went.
    expect(config.plugin).toEqual([['opencode-bar', { key: 'val' }], 'user/keep'])
  })
})

describe('ownership is surgical: install never claims a pre-existing user entry (plan §17.6)', () => {
  it('does NOT own (and uninstall does NOT remove) our id when the user placed it and install added nothing', () => {
    // The user manually added our id alongside their own, with no marker.
    writeFileSync(
      configPath(),
      JSON.stringify({ plugin: [NARU_PLUGIN_ID, 'user/keep-me'] }, null, 2),
    )

    const result = install({ configDir })
    // Install added nothing to the array (id already present); it must NOT
    // record an ownership marker that would make uninstall remove a user entry.
    expect(result.changes.some((c) => c.kind === 'add-plugin')).toBe(false)
    expect(result.changes.some((c) => c.kind === 'add-ownership-marker')).toBe(false)
    const afterInstall = readConfig()
    expect(OWNERSHIP_KEY in afterInstall).toBe(false)

    // Uninstall is a no-op (no marker => nothing of ours to remove); the
    // user-placed Naru entry survives.
    const un = uninstall({ configDir })
    expect(un.changed).toBe(false)
    expect(readConfig().plugin).toEqual([NARU_PLUGIN_ID, 'user/keep-me'])
  })
})

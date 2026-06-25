import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NARU_PLUGIN_SPECIFIER, OPENCODE_CONFIG_FILENAME, install, uninstall } from './installer'

/**
 * OpenCode adapter installer/uninstaller tests (plan §17.6, §21.5).
 *
 * The installer edits the REAL OpenCode config (`opencode.json`, top-level
 * `plugin: string[]`). The plugin ENTRY VALUE is its own ownership marker — no
 * side-band key (e.g. `_naruManaged`) is ever written, since OpenCode validates
 * its config and may reject unknown keys. Every case targets a mktemp config dir
 * so a real `~/.config` is never touched and asserts the contract: the specifier
 * is added to `plugin[]`; unrelated keys + plugin entries are preserved across
 * both install and uninstall; install is idempotent; uninstall removes only our
 * entry and is a no-op on a clean config; and dry-run writes nothing.
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
  it('adds the published specifier to plugin[] in a fresh config dir', () => {
    const result = install({ configDir })

    expect(result.changed).toBe(true)
    expect(result.dryRun).toBe(false)
    expect(result.configPath).toBe(configPath())

    const config = readConfig()
    // The plugin is registered by its published specifier.
    expect(config.plugin).toEqual([NARU_PLUGIN_SPECIFIER])
    // No side-band ownership key is written (OpenCode validates its config).
    expect('_naruManaged' in config).toBe(false)
    // MCP is NEVER enabled by install (plan §17.2/§17.6).
    expect('mcp' in config).toBe(false)
  })

  it('honors a specifier override (local file path for testing)', () => {
    const local = '/abs/path/to/opencode-plugin.ts'
    const result = install({ configDir, specifier: local })
    expect(result.changed).toBe(true)
    expect(readConfig().plugin).toEqual([local])
  })

  it('creates the config file with restrictive 0600 permissions', () => {
    install({ configDir })
    const mode = statSync(configPath()).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('is idempotent: a second install leaves exactly one plugin entry', () => {
    const first = install({ configDir })
    expect(first.changed).toBe(true)

    const second = install({ configDir })
    expect(second.changed).toBe(false)
    expect(second.changes).toEqual([])

    expect(readConfig().plugin).toEqual([NARU_PLUGIN_SPECIFIER])
  })

  it('preserves a pre-existing unrelated config key and plugin entry', () => {
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
    expect(config.plugin).toEqual(['user/their-plugin', NARU_PLUGIN_SPECIFIER])
  })

  it('preserves non-string (tuple/object-form) plugin entries', () => {
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

    expect(readConfig().plugin).toEqual([
      'user/x',
      ['opencode-bar', { key: 'val' }],
      { name: 'obj', opts: { a: 1 } },
      NARU_PLUGIN_SPECIFIER,
    ])
  })

  it('dry-run writes nothing but reports the plan', () => {
    const result = install({ configDir, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.changes.length).toBeGreaterThan(0)
    // Nothing was written.
    expect(configExists()).toBe(false)
  })

  it('installs into a JSONC config (comments + trailing commas) OpenCode accepts', () => {
    // OpenCode reads opencode.json as JSONC; a strict JSON.parse would wrongly
    // abort install on this perfectly-loadable config. The // and trailing
    // commas (incl. inside the array) and the comment-like text inside a string
    // value must all be handled.
    writeFileSync(
      configPath(),
      [
        '{',
        '  // user theme',
        '  "theme": "dark",',
        '  "note": "http://example.com // not a comment",',
        '  /* their plugins */',
        '  "plugin": [',
        '    "user/their-plugin", // keep this',
        '  ],',
        '}',
        '',
      ].join('\n'),
    )

    const result = install({ configDir })
    expect(result.changed).toBe(true)

    const config = readConfig()
    // String contents (including the `//` inside a value) survive untouched.
    expect(config.theme).toBe('dark')
    expect(config.note).toBe('http://example.com // not a comment')
    // The user's plugin is preserved and ours is appended.
    expect(config.plugin).toEqual(['user/their-plugin', NARU_PLUGIN_SPECIFIER])
  })

  it('still refuses a genuinely malformed config', () => {
    writeFileSync(configPath(), '{ "plugin": [ "x" ')
    expect(() => install({ configDir })).toThrow(/not valid JSON or JSONC/)
    // Nothing was overwritten.
    expect(readFileSync(configPath(), 'utf8')).toBe('{ "plugin": [ "x" ')
  })

  it('echoes back projectDir when provided', () => {
    const result = install({ configDir, projectDir: '/tmp/some-project' })
    expect(result.projectDir).toBe('/tmp/some-project')
  })
})

describe('uninstall (plan §17.6)', () => {
  it('removes only our entry and leaves the rest of the config intact', () => {
    // Seed user config (incl. an unrelated plugin + mcp), then install + uninstall.
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
  })

  it('drops the plugin key when it created an array that is now empty', () => {
    install({ configDir })
    uninstall({ configDir })

    const config = readConfig()
    // The plugin array we created (now empty) is dropped.
    expect('plugin' in config).toBe(false)
  })

  it('preserves non-string entries: removes only the owned string entry', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ plugin: [['opencode-bar', { key: 'val' }], 'user/keep'] }, null, 2),
    )
    install({ configDir })
    uninstall({ configDir })

    // The tuple entry and the unrelated user string both remain; only ours went.
    expect(readConfig().plugin).toEqual([['opencode-bar', { key: 'val' }], 'user/keep'])
  })

  it('round-trips an array of only non-string entries (plugin key survives)', () => {
    const userPlugin = [{ path: './local-plugin.ts' }]
    writeFileSync(configPath(), JSON.stringify({ plugin: userPlugin }, null, 2))

    install({ configDir })
    expect(readConfig().plugin).toEqual([{ path: './local-plugin.ts' }, NARU_PLUGIN_SPECIFIER])

    uninstall({ configDir })
    // Only our string entry removed; the user's object entry (and the key) survive.
    expect(readConfig().plugin).toEqual(userPlugin)
  })

  it('honors a specifier override on uninstall (matches install)', () => {
    const local = '/abs/path/to/opencode-plugin.ts'
    install({ configDir, specifier: local })
    const result = uninstall({ configDir, specifier: local })
    expect(result.changed).toBe(true)
    expect('plugin' in readConfig()).toBe(false)
  })

  it('is a no-op on a clean dir (no file)', () => {
    const result = uninstall({ configDir })
    expect(result.changed).toBe(false)
    expect(result.changes).toEqual([])
    // It did not create a file.
    expect(configExists()).toBe(false)
  })

  it('is a no-op when config exists but does not contain our specifier', () => {
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

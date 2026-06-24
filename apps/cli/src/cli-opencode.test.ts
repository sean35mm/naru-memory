import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const entry = 'apps/cli/src/index.ts'

let configDir: string

/** Run `naru opencode <args> --json` and return the parsed stdout envelope. */
function runJson(args: string[]): Record<string, unknown> {
  const stdout = execFileSync('pnpm', ['exec', 'tsx', entry, 'opencode', ...args, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const lines = stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  return JSON.parse(last) as Record<string, unknown>
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'naru-cli-opencode-'))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

/**
 * `naru opencode install|uninstall` (plan §16, §17.6).
 *
 * Spawns cold `tsx` subprocesses against a temp `--config-dir`, so each `it`
 * carries a generous timeout. Validates the install -> uninstall round-trip
 * leaves OpenCode config clean and never enables MCP.
 */
describe('naru opencode (plan §17.6)', () => {
  it('install then uninstall round-trip is ok and MCP-free', () => {
    const installEnv = runJson(['install', '--config-dir', configDir])
    expect(installEnv.ok).toBe(true)
    const installData = installEnv.data as { changed: boolean; configPath: string }
    expect(installData.changed).toBe(true)

    // The config was written with the marked, MCP-free plugin entry.
    const config = JSON.parse(readFileSync(installData.configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(config.plugin).toEqual(['@naru/opencode-adapter'])
    expect('mcp' in config).toBe(false)
    // 0600 perms on the created file (plan §17.6).
    expect(statSync(installData.configPath).mode & 0o777).toBe(0o600)

    const uninstallEnv = runJson(['uninstall', '--config-dir', configDir])
    expect(uninstallEnv.ok).toBe(true)
    const uninstallData = uninstallEnv.data as { changed: boolean }
    expect(uninstallData.changed).toBe(true)

    // Round-tripped clean: our keys are gone.
    const after = JSON.parse(readFileSync(installData.configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect('plugin' in after).toBe(false)
    expect('_naruManaged' in after).toBe(false)
  }, 30_000)

  it('dry-run install writes nothing', () => {
    const env = runJson(['install', '--config-dir', configDir, '--dry-run'])
    expect(env.ok).toBe(true)
    const data = env.data as { dryRun: boolean; configPath: string }
    expect(data.dryRun).toBe(true)
    let exists = true
    try {
      statSync(data.configPath)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  }, 30_000)
})

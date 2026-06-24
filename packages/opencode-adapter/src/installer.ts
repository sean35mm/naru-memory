/**
 * OpenCode adapter installer / uninstaller (plan §17.6, §21.5).
 *
 * The adapter is an INTEGRATION layer, not the memory system: installing it
 * registers the Naru plugin with OpenCode by editing OpenCode's own JSON config
 * file. This module owns ONLY that config wiring — it writes no memory, runs no
 * extraction, opens no DB, and (per OPENCODE INTERFACE POLICY) adds no
 * dependency on OpenCode's package. The shape it writes mirrors OpenCode's
 * documented config (`opencode.json` with a top-level `plugin` array of module
 * specifiers); the constant below pins the contract so the real runtime loads
 * the plugin, while the whole module stays unit-testable offline against a temp
 * dir.
 *
 * Safety (plan §17.6):
 * - **Configurable config dir.** Defaults to the OpenCode user config dir, but
 *   ALWAYS overridable via {@link InstallOptions.configDir} so tests target a
 *   temp dir and never touch a real `~/.config`.
 * - **Ownership markers.** Every entry the adapter adds is recorded under a
 *   single `_naruManaged` block ({@link OWNERSHIP_KEY}). Uninstall removes ONLY
 *   what that block lists and preserves all other user config — including a
 *   pre-existing `plugin` array the user maintains.
 * - **No MCP.** Installation never reads, writes, or enables OpenCode's `mcp`
 *   key (plan §17.2/§17.6).
 * - **Restrictive perms.** Files the installer creates are written `0600` and
 *   any directory it creates is `0700` (the config may grow to hold tokens).
 * - **Dry-run.** {@link InstallOptions.dryRun} / {@link UninstallOptions.dryRun}
 *   compute and return the planned changes WITHOUT writing.
 * - **Idempotent.** Installing twice yields one owned plugin entry; uninstalling
 *   twice (or on a clean dir) is a no-op, never an error.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The plugin module specifier OpenCode loads to activate the Naru adapter.
 *
 * This is the package name (the adapter ships `createPlugin` from its barrel);
 * OpenCode resolves it the same way it resolves any plugin entry. Kept as a
 * single constant so install/uninstall agree on exactly which entry is owned.
 */
export const NARU_PLUGIN_ID = '@naru/opencode-adapter'

/**
 * Basename of the OpenCode config file the installer manages.
 *
 * OpenCode reads `opencode.json` (JSONC is also accepted by the runtime, but we
 * write/round-trip strict JSON so ownership tracking stays exact and we never
 * have to preserve comments). One file per config dir.
 */
export const OPENCODE_CONFIG_FILENAME = 'opencode.json'

/**
 * Top-level key that holds the adapter's ownership marker block.
 *
 * Chosen with a leading underscore + `naru` namespace so it cannot collide with
 * an OpenCode config field. Its value records the plugin entries the adapter
 * added so uninstall can remove EXACTLY those and nothing else (plan §17.6).
 */
export const OWNERSHIP_KEY = '_naruManaged'

/** The marker block written under {@link OWNERSHIP_KEY}. */
interface OwnershipMarker {
  /** Always `true`; the unambiguous "owned by Naru" flag (plan §17.6). */
  managed: true
  /** The adapter package + tooling that wrote this block, for provenance. */
  by: string
  /** Plugin specifiers the adapter added to `plugin` (removed on uninstall). */
  plugins: string[]
}

/** A single planned config mutation, surfaced by dry-run and by the result. */
export interface PlannedChange {
  /** Stable change kind for machine inspection / assertions. */
  kind:
    | 'create-config'
    | 'create-dir'
    | 'add-plugin'
    | 'add-ownership-marker'
    | 'remove-plugin'
    | 'remove-ownership-marker'
    | 'remove-plugin-key'
  /** Human-readable description of the change. */
  detail: string
}

/** Inputs for {@link install} (plan §17.6). */
export interface InstallOptions {
  /**
   * OpenCode config dir to manage. Defaults to {@link defaultOpenCodeConfigDir};
   * ALWAYS pass a temp dir in tests so a real `~/.config` is never touched.
   */
  configDir?: string
  /**
   * Optional project dir. Reserved for future per-project install (OpenCode
   * also reads `<project>/.opencode/opencode.json`); recorded in the result so
   * callers can surface it, but user-level install is the default and only
   * behavior today. Not used to locate the config file.
   */
  projectDir?: string
  /** When `true`, compute + return the plan WITHOUT writing anything. */
  dryRun?: boolean
}

/** Inputs for {@link uninstall} (plan §17.6). */
export interface UninstallOptions {
  /** OpenCode config dir to clean. Defaults to {@link defaultOpenCodeConfigDir}. */
  configDir?: string
  /** When `true`, compute + return the plan WITHOUT writing anything. */
  dryRun?: boolean
}

/** Result of an {@link install} / {@link uninstall} run. */
export interface InstallerResult {
  /** Absolute path of the OpenCode config file managed. */
  configPath: string
  /** Whether anything would change (`dryRun`) or did change. */
  changed: boolean
  /** Whether this was a dry run (no writes performed). */
  dryRun: boolean
  /** The planned/applied changes (empty when already in the desired state). */
  changes: PlannedChange[]
  /** Optional project dir echoed back from {@link InstallOptions.projectDir}. */
  projectDir?: string
}

/**
 * Default OpenCode user config dir (plan §17.6).
 *
 * Follows OpenCode's convention of `$XDG_CONFIG_HOME/opencode`, falling back to
 * `~/.config/opencode`. Resolved lazily (not at module load) so an overridden
 * `HOME`/`XDG_CONFIG_HOME` in a child process is honored, and so importing this
 * module never reads the environment as a side effect.
 */
export function defaultOpenCodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'opencode')
}

/** Absolute path of the managed config file inside `configDir`. */
function configPathFor(configDir: string): string {
  return join(configDir, OPENCODE_CONFIG_FILENAME)
}

/** A loosely-typed view of the OpenCode config object we round-trip. */
type OpenCodeConfig = Record<string, unknown> & {
  plugin?: unknown
  [OWNERSHIP_KEY]?: unknown
}

/**
 * Read + parse the existing config file, or `null` if it is absent.
 *
 * A present-but-unparseable file throws: silently overwriting malformed user
 * config would violate the "preserve user config" rule (plan §17.6). The caller
 * surfaces the error so a human can resolve it.
 */
function readConfig(configPath: string): OpenCodeConfig | null {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
  if (raw.trim().length === 0) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `OpenCode config at ${configPath} is not valid JSON; refusing to overwrite. Fix or remove it, then retry.`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`OpenCode config at ${configPath} is not a JSON object; refusing to overwrite.`)
  }
  return parsed as OpenCodeConfig
}

/**
 * The RAW `plugin` array exactly as the user wrote it (or an empty array when
 * unset / not an array). OpenCode's `plugin` schema allows non-string entries —
 * the tuple form `[name, options]` and object entries — so this preserves EVERY
 * element type. It is the source of truth for write-back; install/uninstall
 * mutate this array (never a string-filtered copy) so a user's tuple/object
 * plugin entries are never silently dropped (plan §17.6 "preserve user config").
 */
function readRawPluginList(config: OpenCodeConfig): unknown[] {
  const value = config.plugin
  return Array.isArray(value) ? [...value] : []
}

/**
 * The string-only VIEW of the `plugin` array, used solely for membership /
 * ownership checks (does our plugin id already appear?). NEVER used to
 * reconstruct the array that gets written — that would drop non-string entries.
 */
function readPluginList(config: OpenCodeConfig): string[] {
  return readRawPluginList(config).filter((entry): entry is string => typeof entry === 'string')
}

/** Read the ownership marker, or `null` when absent / not adapter-shaped. */
function readOwnership(config: OpenCodeConfig): OwnershipMarker | null {
  const value = config[OWNERSHIP_KEY]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const rec = value as Record<string, unknown>
  if (rec.managed !== true) {
    return null
  }
  const plugins = Array.isArray(rec.plugins)
    ? rec.plugins.filter((p): p is string => typeof p === 'string')
    : []
  const by = typeof rec.by === 'string' ? rec.by : NARU_PLUGIN_ID
  return { managed: true, by, plugins }
}

/** Serialize + atomically-enough write the config `0600`, creating the dir `0700`. */
function writeConfig(configPath: string, config: OpenCodeConfig): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mode on writeFileSync is only applied when CREATING the file, so chmod
  // afterward to guarantee 0600 even when overwriting a looser-perm'd file.
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(configPath, 0o600)
}

/**
 * Install the Naru OpenCode adapter (plan §17.6).
 *
 * Adds {@link NARU_PLUGIN_ID} to the config's `plugin` array (creating the array
 * and the file if needed) and records ownership under {@link OWNERSHIP_KEY}.
 * NEVER touches the `mcp` key. Idempotent: a second install with the entry
 * already present and already owned makes no change (`changed: false`). With
 * `dryRun`, returns the plan and writes nothing.
 */
export function install(options: InstallOptions = {}): InstallerResult {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir()
  const dryRun = options.dryRun === true
  const configPath = configPathFor(configDir)
  const existing = readConfig(configPath)

  const changes: PlannedChange[] = []
  const config: OpenCodeConfig = existing === null ? {} : { ...existing }

  if (existing === null) {
    changes.push({ kind: 'create-dir', detail: `create config dir ${configDir} (0700)` })
    changes.push({ kind: 'create-config', detail: `create ${configPath} (0600)` })
  }

  // Operate on the RAW array so user tuple/object plugin entries survive intact
  // (the string view below is only for the membership check).
  const rawPlugins = readRawPluginList(config)
  const alreadyPresent = readPluginList(config).includes(NARU_PLUGIN_ID)
  let added = false
  if (!alreadyPresent) {
    rawPlugins.push(NARU_PLUGIN_ID)
    added = true
    changes.push({ kind: 'add-plugin', detail: `add plugin "${NARU_PLUGIN_ID}"` })
  }
  // Preserve the (possibly user-curated, mixed-type) array as-is when we made
  // no change; write the appended array when we added our entry. Only set the
  // key at all if the array is non-empty so we never materialize an empty one.
  if (rawPlugins.length > 0) {
    config.plugin = rawPlugins
  }

  // Ownership reflects only what THIS install ADDED (or what a prior marker
  // already owns). If our id pre-existed but Naru did not add it and no marker
  // claims it, do NOT claim it — uninstall must stay surgical (§17.6: "remove
  // only owned entries"), and removing a user-placed entry would over-claim.
  const ownership = readOwnership(config)
  const ownedPlugins = ownership?.plugins ?? []
  const alreadyOwned = ownedPlugins.includes(NARU_PLUGIN_ID)
  const shouldOwn = added || alreadyOwned
  if (shouldOwn && !alreadyOwned) {
    config[OWNERSHIP_KEY] = {
      managed: true,
      by: NARU_PLUGIN_ID,
      plugins: [...ownedPlugins, NARU_PLUGIN_ID],
    } satisfies OwnershipMarker
    changes.push({
      kind: 'add-ownership-marker',
      detail: `record ownership marker for "${NARU_PLUGIN_ID}"`,
    })
  }

  const changed = changes.length > 0
  if (changed && !dryRun) {
    writeConfig(configPath, config)
  }

  return {
    configPath,
    changed,
    dryRun,
    changes,
    ...(options.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
  }
}

/**
 * Uninstall the Naru OpenCode adapter (plan §17.6).
 *
 * Removes ONLY the plugin entries the ownership marker lists, then removes the
 * marker itself, preserving every other config key (including unrelated plugin
 * entries the user added). If removing the owned plugins leaves an EMPTY array
 * the adapter created, the `plugin` key is dropped so the config is restored to
 * its pre-install shape. Never touches `mcp`. Idempotent: on a clean dir (no
 * file, or no marker) it is a no-op (`changed: false`), never an error. With
 * `dryRun`, returns the plan and writes nothing.
 */
export function uninstall(options: UninstallOptions = {}): InstallerResult {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir()
  const dryRun = options.dryRun === true
  const configPath = configPathFor(configDir)
  const existing = readConfig(configPath)

  // No file, or a file with no ownership marker -> nothing of ours to remove.
  if (existing === null) {
    return { configPath, changed: false, dryRun, changes: [] }
  }
  const ownership = readOwnership(existing)
  if (!ownership) {
    return { configPath, changed: false, dryRun, changes: [] }
  }

  const changes: PlannedChange[] = []

  // Rebuild the config WITHOUT the keys we own, rather than mutating with the
  // `delete` operator (the repo lints `noDelete`). `_naruManaged` is always
  // dropped; `plugin` is dropped here and re-added below only when entries
  // survive — so a now-empty array we created never lingers.
  const { plugin: _plugin, [OWNERSHIP_KEY]: _owned, ...rest } = existing
  const config: OpenCodeConfig = rest

  // Filter the RAW array: drop ONLY string entries that the marker owns. Every
  // non-string entry (tuple `[name, options]` / object form) is preserved in
  // place — uninstall never matches or removes a user's non-string plugin.
  const ownedSet = new Set(ownership.plugins)
  const rawBefore = readRawPluginList(existing)
  const rawAfter = rawBefore.filter((entry) => !(typeof entry === 'string' && ownedSet.has(entry)))
  for (const removed of rawBefore.filter(
    (entry): entry is string => typeof entry === 'string' && ownedSet.has(entry),
  )) {
    changes.push({ kind: 'remove-plugin', detail: `remove plugin "${removed}"` })
  }
  if (rawAfter.length > 0) {
    config.plugin = rawAfter
  } else if (rawBefore.length > 0) {
    // The RAW array is now empty (we removed the only entries it held, and there
    // were no non-string entries to keep); leaving the key out restores the
    // config to its pre-install shape.
    changes.push({ kind: 'remove-plugin-key', detail: 'remove now-empty "plugin" array' })
  }

  changes.push({ kind: 'remove-ownership-marker', detail: 'remove Naru ownership marker' })

  const changed = changes.length > 0
  if (changed && !dryRun) {
    writeConfig(configPath, config)
  }

  return { configPath, changed, dryRun, changes }
}

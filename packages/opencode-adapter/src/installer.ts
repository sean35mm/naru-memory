/**
 * OpenCode adapter installer / uninstaller (plan §17.6, §21.5).
 *
 * Installing the adapter registers the Naru plugin with the REAL OpenCode
 * runtime by editing OpenCode's own config file. OpenCode's config
 * (`opencode.json`) carries a top-level `plugin?: string[]` of module
 * specifiers; activating Naru means adding our published specifier
 * ({@link NARU_PLUGIN_SPECIFIER}) to that array. This module owns ONLY that
 * config wiring — it writes no memory, runs no extraction, and opens no DB.
 *
 * Ownership model (per task brief): the plugin ENTRY VALUE is its own ownership
 * marker. OpenCode validates its config and may reject unknown keys, so we do
 * NOT add a side-band marker key (e.g. `_naruManaged`). Uninstall removes ONLY
 * the exact specifier string we added and leaves every other plugin entry and
 * config key untouched.
 *
 * Safety (plan §17.6):
 * - **Configurable config dir.** Defaults to the OpenCode user config dir, but
 *   ALWAYS overridable via {@link InstallOptions.configDir} so tests target a
 *   temp dir and never touch a real `~/.config`.
 * - **Configurable specifier.** Defaults to the published npm specifier, but
 *   overridable via {@link InstallOptions.specifier} so local testing can
 *   register a file path instead of the npm name.
 * - **Preserve user config.** Every other key, and every other `plugin` entry
 *   (including the tuple `[name, options]` and object forms OpenCode allows),
 *   round-trips byte-for-shape unchanged.
 * - **Restrictive perms.** Files the installer creates are written `0600` and
 *   any directory it creates is `0700` (the config may grow to hold tokens).
 * - **Dry-run.** {@link InstallOptions.dryRun} / {@link UninstallOptions.dryRun}
 *   compute and return the planned changes WITHOUT writing.
 * - **Idempotent.** Installing twice yields one plugin entry; uninstalling twice
 *   (or on a clean dir) is a no-op, never an error.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The published module specifier OpenCode loads to activate the Naru adapter.
 *
 * This is the publishable CLI package's `./opencode` subpath
 * (`@narulabs/naru/opencode`), which re-exports the real `@opencode-ai/plugin`
 * surface. OpenCode resolves it like any other `plugin` array entry. The entry
 * value is itself the ownership marker — install adds exactly this string and
 * uninstall removes exactly this string.
 */
export const NARU_PLUGIN_SPECIFIER = '@narulabs/naru/opencode'

/**
 * Basename of the OpenCode config file the installer manages.
 *
 * OpenCode reads `opencode.json` as JSONC (comments and trailing commas are
 * accepted by the runtime — a real on-disk example is `{ "$schema": "...", }`).
 * We therefore PARSE tolerantly (see {@link parseJsonc}) so a JSONC config the
 * host happily loads does not abort the install, but WRITE strict JSON via
 * `JSON.stringify`. Consequence: any comments in the user's config are dropped
 * on write-back. Preserving comments/formatting is out of scope; correctness
 * (not refusing on a config OpenCode itself accepts) is the goal. One file per
 * config dir.
 */
export const OPENCODE_CONFIG_FILENAME = 'opencode.json'

/** A single planned config mutation, surfaced by dry-run and by the result. */
export interface PlannedChange {
  /** Stable change kind for machine inspection / assertions. */
  kind: 'create-config' | 'create-dir' | 'add-plugin' | 'remove-plugin' | 'remove-plugin-key'
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
   * Plugin specifier to register. Defaults to {@link NARU_PLUGIN_SPECIFIER}.
   * Override for LOCAL testing to register a file path instead of the npm name.
   */
  specifier?: string
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
  /** Plugin specifier to remove. Defaults to {@link NARU_PLUGIN_SPECIFIER}. */
  specifier?: string
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
type OpenCodeConfig = Record<string, unknown> & { plugin?: unknown }

/**
 * Parse JSONC (JSON-with-comments) text the way OpenCode's runtime does.
 *
 * OpenCode accepts `//` line comments, `/* … *\/` block comments, and trailing
 * commas in its config; strict `JSON.parse` does not, so reading such a file
 * with `JSON.parse` would wrongly abort the install on a config the host itself
 * loads. This strips comments and trailing commas — both string-literal-aware so
 * comment/comma characters INSIDE a JSON string are left untouched — then hands
 * the cleaned text to `JSON.parse`. A genuinely malformed file still throws from
 * `JSON.parse`. (Comments are not preserved on write-back; see
 * {@link OPENCODE_CONFIG_FILENAME}.)
 */
function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ch
      }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') {
        // Escaped char (e.g. `\"`): copy it verbatim so we don't mistake a
        // closing quote.
        out += next ?? ''
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    out += ch
  }
  // Remove trailing commas before a closing `}` or `]` (now that comments and
  // string contents can't interfere). Whitespace between the comma and the
  // closer is allowed.
  const withoutTrailingCommas = out.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(withoutTrailingCommas)
}

/**
 * Read + parse the existing config file, or `null` if it is absent.
 *
 * The file is parsed as JSONC ({@link parseJsonc}) so a config using comments or
 * trailing commas — both of which OpenCode's runtime accepts — does not abort
 * the install. A present-but-genuinely-malformed file throws: silently
 * overwriting malformed user config would violate the "preserve user config"
 * rule (plan §17.6). The caller surfaces the error so a human can resolve it.
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
    parsed = parseJsonc(raw)
  } catch {
    throw new Error(
      `OpenCode config at ${configPath} is not valid JSON or JSONC; refusing to overwrite. Fix or remove it, then retry.`,
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

/** Whether the RAW array already contains our exact specifier string. */
function containsSpecifier(rawPlugins: unknown[], specifier: string): boolean {
  return rawPlugins.some((entry) => typeof entry === 'string' && entry === specifier)
}

/** Serialize + write the config `0600`, creating the dir `0700`. */
function writeConfig(configPath: string, config: OpenCodeConfig): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `mode` on writeFileSync is only applied when CREATING the file, so chmod
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
 * Adds the resolved specifier (default {@link NARU_PLUGIN_SPECIFIER}) to the
 * config's `plugin` array, creating the array and the file if needed. The entry
 * value is its own ownership marker — no side-band key is written. Preserves all
 * other config keys and all other plugin entries (string, tuple, or object form)
 * exactly. Idempotent: a second install with the specifier already present makes
 * no change (`changed: false`). With `dryRun`, returns the plan and writes
 * nothing.
 */
export function install(options: InstallOptions = {}): InstallerResult {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir()
  const specifier = options.specifier ?? NARU_PLUGIN_SPECIFIER
  const dryRun = options.dryRun === true
  const configPath = configPathFor(configDir)
  const existing = readConfig(configPath)

  const changes: PlannedChange[] = []
  const config: OpenCodeConfig = existing === null ? {} : { ...existing }

  if (existing === null) {
    changes.push({ kind: 'create-dir', detail: `create config dir ${configDir} (0700)` })
    changes.push({ kind: 'create-config', detail: `create ${configPath} (0600)` })
  }

  // Operate on the RAW array so user tuple/object plugin entries survive intact.
  const rawPlugins = readRawPluginList(config)
  if (!containsSpecifier(rawPlugins, specifier)) {
    rawPlugins.push(specifier)
    changes.push({ kind: 'add-plugin', detail: `add plugin "${specifier}"` })
  }
  // Only set the key when the array is non-empty so we never materialize an
  // empty `plugin` array (the array always holds at least our entry here).
  if (rawPlugins.length > 0) {
    config.plugin = rawPlugins
  }

  // A fresh-file create with the entry added is one logical change set; if the
  // entry already existed and nothing else needed creating, there is no change.
  const changed = changes.some((c) => c.kind === 'add-plugin' || c.kind === 'create-config')
  if (changed && !dryRun) {
    writeConfig(configPath, config)
  }

  return {
    configPath,
    changed,
    dryRun,
    changes: changed ? changes : [],
    ...(options.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
  }
}

/**
 * Uninstall the Naru OpenCode adapter (plan §17.6).
 *
 * Removes ONLY the exact resolved specifier (default {@link NARU_PLUGIN_SPECIFIER})
 * from the `plugin` array, preserving every other config key and every other
 * plugin entry (including unrelated string entries and the tuple/object forms).
 * If removing our entry leaves an EMPTY array, the `plugin` key is dropped so the
 * config is restored to its pre-install shape. Idempotent: when our specifier is
 * absent (clean dir, or a config that never had it) it is a no-op
 * (`changed: false`), never an error. With `dryRun`, returns the plan and writes
 * nothing.
 */
export function uninstall(options: UninstallOptions = {}): InstallerResult {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir()
  const specifier = options.specifier ?? NARU_PLUGIN_SPECIFIER
  const dryRun = options.dryRun === true
  const configPath = configPathFor(configDir)
  const existing = readConfig(configPath)

  // No file -> nothing of ours to remove.
  if (existing === null) {
    return { configPath, changed: false, dryRun, changes: [] }
  }

  const rawBefore = readRawPluginList(existing)
  if (!containsSpecifier(rawBefore, specifier)) {
    // Our specifier is not present -> a no-op (preserve everything as-is).
    return { configPath, changed: false, dryRun, changes: [] }
  }

  const changes: PlannedChange[] = []

  // Rebuild the config WITHOUT the `plugin` key, then re-add the filtered array
  // below only when entries survive (avoids the `delete` operator the repo lints
  // against, and ensures a now-empty array we emptied never lingers).
  const { plugin: _plugin, ...rest } = existing
  const config: OpenCodeConfig = rest

  // Filter the RAW array: drop ONLY the exact string entries equal to our
  // specifier. Every other entry (other strings, tuples, objects) is preserved.
  const rawAfter = rawBefore.filter((entry) => !(typeof entry === 'string' && entry === specifier))
  changes.push({ kind: 'remove-plugin', detail: `remove plugin "${specifier}"` })

  if (rawAfter.length > 0) {
    config.plugin = rawAfter
  } else {
    // The array is now empty (our entry was the only one); leaving the key out
    // restores the config to its pre-install shape.
    changes.push({ kind: 'remove-plugin-key', detail: 'remove now-empty "plugin" array' })
  }

  if (!dryRun) {
    writeConfig(configPath, config)
  }

  return { configPath, changed: true, dryRun, changes }
}

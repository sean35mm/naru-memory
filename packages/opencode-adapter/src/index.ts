/**
 * `@naru/opencode-adapter` — native OpenCode integration for Naru Memory
 * (plan §17).
 *
 * This package is an INTEGRATION layer, not the memory system (§17.1/§17.2): it
 * resolves scopes, registers native tools, and (later) wires hooks for memory
 * search/injection/compaction — all by calling Naru core APIs (embedded) or a
 * running local server through {@link AdapterClient}. It owns no memory logic,
 * no extraction, no direct DB writes, and no schema, and adds NO dependency on
 * OpenCode's package (the local plugin contract in `types.ts` mirrors it).
 *
 * Barrel exports:
 * - the LOCAL plugin contract types (`types.ts`),
 * - scope resolution utils (`scope.ts`),
 * - the adapter memory client + resolver (`client.ts`),
 * - the eight native tools (`tools.ts`),
 * - the hooks (`hooks.ts`),
 * - the plugin factory {@link createPlugin} (assembles tools + hooks).
 *
 * The factory returns a {@link Hooks} object with all six §17.4 hooks wired
 * (config / chat.message / experimental.chat.messages.transform /
 * tool.execute.after / experimental.session.compacting / shell.env). The
 * installer/uninstaller (`installer.ts`, §17.6) registers this plugin with
 * OpenCode's config using ownership markers, dry-run, and no MCP.
 */

export type { AdapterClient, AdapterClientMode, AdapterStatus } from './client'
export { EmbeddedAdapterClient, RemoteAdapterClient, resolveAdapterClient } from './client'
export type { HookOptions, MemoryIntent, MemorySink, SurfacedMemory } from './hooks'
export { createHooks, detectMemoryIntent } from './hooks'
export type {
  InstallerResult,
  InstallOptions,
  PlannedChange,
  UninstallOptions,
} from './installer'
export {
  defaultOpenCodeConfigDir,
  install,
  NARU_PLUGIN_ID,
  OPENCODE_CONFIG_FILENAME,
  OWNERSHIP_KEY,
  uninstall,
} from './installer'
export type { GitRunner, ResolvedScopes, ResolveScopesInput, ScopeRef } from './scope'
export { defaultGitRunner, projectKeyFromRemote, resolveScopes } from './scope'
export type { AddMemoryResult } from './tools'
export { createTools, NATIVE_TOOL_NAMES } from './tools'
export type {
  ChatMessage,
  ChatMessageHookInput,
  ConfigHookInput,
  Hooks,
  MessagesTransformHookInput,
  PluginContext,
  PluginFactory,
  SessionCompactingHookInput,
  ShellEnvHookInput,
  ToolContext,
  ToolDefinition,
  ToolExecuteAfterHookInput,
  ToolParameters,
} from './types'

import { type HookOptions, createHooks } from './hooks'
import { createTools } from './tools'
import type { Hooks, PluginContext, ToolDefinition } from './types'

/**
 * The assembled plugin: the registered tools plus the OpenCode {@link Hooks}.
 *
 * Returned by {@link createPlugin}. The real OpenCode runtime consumes `hooks`
 * (dispatching by the §17.4 names); `tools` is exposed so the `config` hook —
 * and tests — can advertise/inspect them without re-deriving the list.
 */
export interface NaruPlugin {
  tools: ToolDefinition[]
  hooks: Hooks
}

/**
 * Assemble the Naru OpenCode plugin from an injected {@link PluginContext}
 * (plan §17). PURE: every tool and hook is driven by the injected client +
 * scope resolver, so the whole plugin is unit-testable offline against a mock
 * context and an embedded `:memory:` Naru (no OpenCode runtime, no network).
 *
 * All six §17.4 hooks are wired via {@link createHooks}: `config` registers the
 * native tools (§17.3) and enables NO MCP (§17.2/§17.6); `chat.message` detects
 * remember/recall intents; `experimental.chat.messages.transform` injects
 * memory context once per turn; `tool.execute.after` surfaces prior fixes on a
 * failure; `experimental.session.compacting` preserves context; and `shell.env`
 * exports scope/session env vars. `tools` is exposed so the installer/tests can
 * inspect the registered set without re-deriving it.
 *
 * `options` threads the {@link HookOptions} seam (the {@link MemorySink} the
 * runtime uses to present surfaced recall/error/compaction memory, plus limits)
 * so the real shim can wire presentation without re-implementing the hooks.
 *
 * A thin shim adapts the real OpenCode runtime's plugin entrypoint
 * ({@link PluginFactory}) into a {@link PluginContext} (resolving the client via
 * {@link resolveAdapterClient} and the scope resolver via {@link resolveScopes})
 * and then calls this — that shim lands with the installer.
 */
export function createPlugin(ctx: PluginContext, options?: HookOptions): NaruPlugin {
  const tools = createTools(ctx)
  const hooks = createHooks(ctx, options ?? {})
  return { tools, hooks }
}

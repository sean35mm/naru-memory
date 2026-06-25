/**
 * `@naru/opencode-adapter` — native OpenCode integration for Naru Memory
 * (plan §17).
 *
 * This package is an INTEGRATION layer, not the memory system (§17.1/§17.2): it
 * resolves scopes, registers the real `@opencode-ai/plugin` surface, and wires
 * hooks for memory search/injection/compaction — all by talking to a running
 * `naru serve` over tRPC (REMOTE-ONLY, because OpenCode runs on Bun where the
 * native `better-sqlite3` will not load). It owns no memory logic, no
 * extraction, no direct DB writes, and no schema.
 *
 * Barrel exports:
 * - scope resolution utils (`scope.ts`),
 * - the remote-only memory client (`remote.ts`),
 * - the real OpenCode plugin + hook builders (`opencode-plugin.ts`),
 * - the installer / uninstaller (`installer.ts`, §17.6).
 *
 * IMPORTANT: the production plugin OpenCode loads is the `./plugin` subpath
 * ({@link file://./opencode-plugin.ts}), which is deliberately Bun-safe — it
 * imports ONLY `@opencode-ai/plugin`, `@trpc/client`, a TYPE-ONLY `@naru/api`,
 * and node builtins. This barrel re-exports it (and the installer) for the CLI
 * and tests; importing the barrel pulls nothing that loads `better-sqlite3`.
 */

export type {
  InstallerResult,
  InstallOptions,
  PlannedChange,
  UninstallOptions,
} from './installer'
export {
  defaultOpenCodeConfigDir,
  install,
  NARU_PLUGIN_SPECIFIER,
  OPENCODE_CONFIG_FILENAME,
  uninstall,
} from './installer'
export type {
  MemoryIntent,
  NaruHookDeps,
  ScopeResolver,
} from './opencode-plugin'
export { buildNaruHooks, detectMemoryIntent, NaruMemory } from './opencode-plugin'
export type {
  RemoteClient,
  RemoteClientOptions,
  RemoteServerTarget,
  ResolvedServer,
  ServerResolutionSource,
} from './remote'
export {
  createRemoteClient,
  isNoServerError,
  NO_SERVER_MESSAGE,
  NoServerError,
} from './remote'
export type { GitRunner, ResolvedScopes, ResolveScopesInput, ScopeRef } from './scope'
export { defaultGitRunner, projectKeyFromRemote, resolveScopes } from './scope'

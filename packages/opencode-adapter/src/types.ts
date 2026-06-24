/**
 * LOCAL OpenCode plugin contract (plan §17.4).
 *
 * Naru deliberately does NOT depend on OpenCode's package (the
 * OPENCODE INTERFACE POLICY). These interfaces *mirror* OpenCode's plugin API
 * shape so the adapter can be authored and unit-tested entirely offline, then
 * wired into the real OpenCode runtime by a thin shim (see {@link installer} /
 * the plugin factory in `index.ts`). When the real runtime loads this plugin it
 * supplies the concrete context/hook payloads; here we model only the surface
 * the adapter touches, kept structural so the real objects assign to these
 * types without an OpenCode import.
 *
 * Design rule (per task brief): every hook + tool is a PURE function driven by
 * an INJECTED context/client. Nothing here reaches for ambient globals, a real
 * server, or a real OpenCode instance — that is what makes the whole adapter
 * testable against a mock context and an embedded `:memory:` Naru.
 */

import type { AdapterClient } from './client'
import type { ResolvedScopes } from './scope'

/**
 * A JSON-schema-ish / zod-like parameter descriptor for a native tool.
 *
 * OpenCode accepts a zod object (or a JSON-schema object) describing a tool's
 * arguments. We keep the type intentionally loose (`unknown` per field) because
 * the adapter validates args itself with zod inside {@link ToolDefinition.execute}
 * — the descriptor here is what gets advertised to the model/runtime, not the
 * runtime validator. A zod object literal assigns to this without a cast.
 */
export type ToolParameters = Record<string, unknown>

/**
 * Per-invocation context handed to a tool's `execute` (plan §17.4).
 *
 * Mirrors the OpenCode tool execution context. Only the fields the Naru tools
 * read are modeled. The Naru-specific `client` + scope inputs are injected by
 * the adapter's own wiring (the factory closes over a resolved {@link AdapterClient}
 * and derives scopes from `cwd`/`sessionId`/`agentId`), NOT supplied by OpenCode.
 */
export interface ToolContext {
  /** Working directory of the OpenCode session (drives scope resolution, §17.5). */
  cwd: string
  /** OpenCode session id, mapped to the `session` scope (§17.5). */
  sessionId?: string
  /** OpenCode agent/model identity, mapped to the `agent` scope (§17.5). */
  agentId?: string
  /** Optional abort signal forwarded by the runtime; reads stay fast (§13.2). */
  abort?: AbortSignal
}

/**
 * A native OpenCode tool (plan §17.3).
 *
 * Matches OpenCode's tool shape: a name, a model-facing description, a
 * parameters descriptor, and an async `execute(args, ctx)` returning a
 * structured result. The adapter's tools validate `args` with zod and map to
 * Naru core/server APIs — they own no memory logic (§17.2).
 *
 * `Result` is the structured payload returned to the runtime/model. It is kept
 * generic so each tool can declare its precise return type while still being a
 * `ToolDefinition`.
 */
export interface ToolDefinition<Result = unknown> {
  name: string
  description: string
  /** Argument descriptor advertised to the runtime (zod/JSON-schema-ish). */
  parameters: ToolParameters
  /** Validate `args`, map to the injected client, return a structured result. */
  execute(args: unknown, ctx: ToolContext): Promise<Result>
}

/**
 * The injected context every hook/tool factory closes over (Naru-side).
 *
 * This is the dependency-injection seam: the plugin factory builds this once
 * (a resolved {@link AdapterClient} bound to the active DB/server, plus a git
 * runner for scope resolution) and threads it into the tools and hooks. Tests
 * construct it directly with an embedded `:memory:` client and a fake git
 * runner — no OpenCode runtime, no network.
 */
export interface PluginContext {
  /** Resolved Naru client (embedded or remote), the adapter's only write path. */
  client: AdapterClient
  /**
   * Resolve the typed scope set for a given location/session/agent (§17.5).
   * Injected so tests can stub git; defaults to the real git-backed resolver.
   */
  resolveScopes(input: {
    cwd: string
    sessionId?: string
    agentId?: string
  }): ResolvedScopes
}

/** A captured chat message as seen by `chat.message` (§17.4). Structural mirror. */
export interface ChatMessage {
  role: string
  content: string
}

/**
 * Hook payloads + return shapes, modeled structurally to mirror OpenCode's
 * hook signatures (plan §17.4). Each is optional on {@link Hooks}; the real
 * runtime invokes whichever the plugin returns. Read/inject hooks must hit only
 * fast retrieval paths and capture hooks must be fire-and-forget (§13.2, §17.4)
 * — enforced by the hook implementations, not the types.
 *
 * NOTE: the concrete payload fields are deliberately permissive (`unknown` /
 * optional) because the real runtime owns the exact shape; the hook
 * implementations narrow what they actually consume. The hook *names* match
 * §17.4 exactly so OpenCode wires them by key.
 */

/** Args for the `config` hook: register tools + skills/commands (§17.4). */
export interface ConfigHookInput {
  /** Mutable config object the runtime hands in; the hook augments it. */
  config: Record<string, unknown>
}

/** Args for `chat.message`: the incoming user message + session info (§17.4). */
export interface ChatMessageHookInput {
  message: ChatMessage
  cwd: string
  sessionId?: string
  agentId?: string
}

/** Args for `experimental.chat.messages.transform`: the prompt message list (§17.4). */
export interface MessagesTransformHookInput {
  messages: ChatMessage[]
  cwd: string
  sessionId?: string
  agentId?: string
}

/** Args for `tool.execute.after`: the just-finished tool call + its outcome (§17.4). */
export interface ToolExecuteAfterHookInput {
  tool: string
  /** Whether the tool call errored (drives the prior-fix lookup, §17.4). */
  error?: { message: string } | null
  cwd: string
  sessionId?: string
  agentId?: string
}

/** Args for `experimental.session.compacting`: the compaction summary (§17.4). */
export interface SessionCompactingHookInput {
  summary: string
  cwd: string
  sessionId?: string
  agentId?: string
}

/** Args for `shell.env`: the env map the hook augments with Naru vars (§17.4). */
export interface ShellEnvHookInput {
  env: Record<string, string>
  cwd: string
  sessionId?: string
  agentId?: string
}

/**
 * The hooks object a plugin returns (plan §17.4).
 *
 * Hook keys MATCH OpenCode's names exactly so the runtime dispatches by key.
 * Every hook is optional and pure (driven by injected state). Concrete
 * implementations land alongside the factory; this contract pins the names +
 * signatures.
 */
export interface Hooks {
  /** Register tools and skills/commands (§17.4). */
  config?: (input: ConfigHookInput) => void | Promise<void>
  /** Detect remember/resume prompts and search relevant memory (§17.4). */
  'chat.message'?: (input: ChatMessageHookInput) => void | Promise<void>
  /** Inject memory context into the prompt (§17.4). Returns possibly-augmented messages. */
  'experimental.chat.messages.transform'?: (
    input: MessagesTransformHookInput,
  ) => ChatMessage[] | Promise<ChatMessage[]>
  /** Detect tool errors and search prior fixes/gotchas (§17.4). */
  'tool.execute.after'?: (input: ToolExecuteAfterHookInput) => void | Promise<void>
  /** Store compaction state and inject prior context (§17.4). */
  'experimental.session.compacting'?: (input: SessionCompactingHookInput) => void | Promise<void>
  /** Export Naru scope/session env vars (§17.4). Returns env additions. */
  'shell.env'?: (
    input: ShellEnvHookInput,
  ) => Record<string, string> | Promise<Record<string, string>>
}

/**
 * The plugin factory type (plan §17): an async factory returning a hooks
 * object, mirroring OpenCode's plugin entrypoint.
 *
 * The real OpenCode runtime calls the factory with its own runtime handle; our
 * shim adapts that into a {@link PluginContext} (resolving the client + scope
 * resolver) before delegating to the pure assembly. Tests call the assembly
 * directly with a hand-built {@link PluginContext}.
 */
export type PluginFactory<RuntimeInput = unknown> = (input: RuntimeInput) => Promise<Hooks>

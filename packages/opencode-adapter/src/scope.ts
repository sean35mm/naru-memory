/**
 * OpenCode scope resolution (plan §17.5).
 *
 * Maps an OpenCode session's location/identity to Naru's typed scope graph
 * (§9.1): user / workspace / project / branch / session / agent. This is the
 * adapter's only "environment sensing" — it reads the OS user, the cwd, and git
 * metadata, then hands the result to the (scope-safe) Naru APIs. It owns no
 * memory logic.
 *
 * Purity + testability: all git access goes through an INJECTED
 * {@link GitRunner}, and the OS user is read once at module load (overridable).
 * With a fake git runner the whole resolver is deterministic and offline — the
 * real runner shells out to `git` via `child_process` with safe fallbacks so a
 * non-git directory never throws (this very repo is not a git repo).
 */

import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { basename } from 'node:path'

/** The six concrete scope types the adapter resolves (plan §17.5, §9.1). */
export interface ResolvedScopes {
  /** OS user (or configured Naru user id). */
  user: ScopeRef
  /** Local workspace root (the session cwd). */
  workspace: ScopeRef
  /** git remote `owner/repo`, else git root dir name, else cwd basename. */
  project: ScopeRef
  /** Current git branch; `null` when not a git repo / detached. */
  branch: ScopeRef | null
  /** OpenCode session id; `null` when the runtime supplies none. */
  session: ScopeRef | null
  /** OpenCode agent/model identity; `null` when unavailable. */
  agent: ScopeRef | null
}

/** A resolved scope reference: its Naru scope type + key part (plan §11.2). */
export interface ScopeRef {
  type: 'user' | 'workspace' | 'project' | 'branch' | 'session' | 'agent'
  key: string
}

/** Inputs for {@link resolveScopes} (plan §17.5). */
export interface ResolveScopesInput {
  /** Session working directory; drives workspace/project/branch resolution. */
  cwd: string
  /** OpenCode session id (mapped to the `session` scope). */
  sessionId?: string
  /** OpenCode agent/model identity (mapped to the `agent` scope). */
  agentId?: string
  /** Override the resolved user key (configured Naru user id, §17.5). */
  user?: string
}

/**
 * Minimal git accessor injected into {@link resolveScopes} so tests can drive
 * scope resolution deterministically without a real repository.
 *
 * Each method returns the resolved value or `null` when git is unavailable /
 * the directory is not a repo. Implementations MUST NOT throw — a non-git
 * directory is a normal case, not an error (plan §17.5 "safe fallbacks").
 */
export interface GitRunner {
  /** `git remote get-url origin`, or `null` if no remote/not a repo. */
  remoteUrl(cwd: string): string | null
  /** `git rev-parse --show-toplevel` (repo root), or `null` if not a repo. */
  topLevel(cwd: string): string | null
  /** `git rev-parse --abbrev-ref HEAD` (branch), or `null` if not a repo/detached. */
  currentBranch(cwd: string): string | null
}

/**
 * Default {@link GitRunner} backed by `git` via `child_process` (plan §17.5).
 *
 * Every call is wrapped so a missing `git`, a non-git directory, or a detached
 * HEAD yields `null` rather than throwing. stderr is suppressed and a short
 * timeout bounds a hung git invocation.
 */
export const defaultGitRunner: GitRunner = {
  remoteUrl(cwd) {
    return runGit(['remote', 'get-url', 'origin'], cwd)
  },
  topLevel(cwd) {
    return runGit(['rev-parse', '--show-toplevel'], cwd)
  },
  currentBranch(cwd) {
    const ref = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    // A detached HEAD reports the literal "HEAD"; treat that as no branch.
    return ref === null || ref === 'HEAD' ? null : ref
  },
}

/** Run a git subcommand in `cwd`, returning trimmed stdout or `null` on any failure. */
function runGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5000,
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/** Read the OS username with a stable fallback (mirrors the CLI's `osUsername`). */
function osUsername(): string {
  try {
    const name = userInfo().username
    return name && name.length > 0 ? name : 'default'
  } catch {
    return 'default'
  }
}

/**
 * Derive a stable `owner/repo` project key from a git remote URL.
 *
 * Handles the common SSH (`git@host:owner/repo.git`), scp-like, and HTTPS
 * (`https://host/owner/repo.git`) shapes. Strips a trailing `.git` and any
 * leading path so the key is portable across clone protocols. Returns `null`
 * when the URL does not yield an `owner/repo` pair so the caller can fall back.
 */
export function projectKeyFromRemote(remoteUrl: string): string | null {
  let path = remoteUrl.trim()
  if (path.length === 0) {
    return null
  }
  // SSH scp-like form: git@host:owner/repo(.git)
  const scp = path.match(/^[^/@]+@[^:/]+:(.+)$/)
  if (scp?.[1] !== undefined) {
    path = scp[1]
  } else {
    // URL form (https://, ssh://, git://): take the part after the host.
    const url = path.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\/(.+)$/)
    if (url?.[1] !== undefined) {
      path = url[1]
    }
  }
  path = path.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
  if (path.length === 0) {
    return null
  }
  const segments = path.split('/').filter((s) => s.length > 0)
  if (segments.length >= 2) {
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
  }
  // A single segment is a bare repo name; still usable as a project key.
  return segments.length === 1 ? (segments[0] as string) : null
}

/**
 * Resolve the typed scope set for an OpenCode session (plan §17.5).
 *
 * Resolution per scope:
 * - `user`: explicit `input.user` > OS username (fallback `default`).
 * - `workspace`: the session cwd (the local workspace root).
 * - `project`: git remote `owner/repo` > git root directory name > cwd basename.
 * - `branch`: current git branch; `null` when not a repo / detached.
 * - `session`: provided OpenCode session id; `null` when absent.
 * - `agent`: provided OpenCode agent/model id; `null` when absent.
 *
 * Pure given a {@link GitRunner}: inject a fake runner for deterministic tests;
 * the default runner degrades safely outside a git repo (no throw).
 */
export function resolveScopes(
  input: ResolveScopesInput,
  git: GitRunner = defaultGitRunner,
): ResolvedScopes {
  const { cwd } = input

  const userKey = input.user && input.user.length > 0 ? input.user : osUsername()

  // project: remote owner/repo -> git root dir name -> cwd basename.
  let projectKey: string | null = null
  const remote = git.remoteUrl(cwd)
  if (remote !== null) {
    projectKey = projectKeyFromRemote(remote)
  }
  if (projectKey === null) {
    const top = git.topLevel(cwd)
    if (top !== null) {
      projectKey = basename(top) || null
    }
  }
  if (projectKey === null) {
    projectKey = basename(cwd) || 'default'
  }

  const branch = git.currentBranch(cwd)

  return {
    user: { type: 'user', key: userKey },
    workspace: { type: 'workspace', key: cwd },
    project: { type: 'project', key: projectKey },
    branch: branch !== null ? { type: 'branch', key: branch } : null,
    session:
      input.sessionId && input.sessionId.length > 0
        ? { type: 'session', key: input.sessionId }
        : null,
    agent: input.agentId && input.agentId.length > 0 ? { type: 'agent', key: input.agentId } : null,
  }
}

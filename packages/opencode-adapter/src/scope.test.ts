import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type GitRunner, projectKeyFromRemote, resolveScopes } from './scope'

/**
 * Build a fake {@link GitRunner} from fixed values so scope resolution is
 * deterministic and offline (plan §17.5) — no real repo, no `child_process`.
 */
function fakeGit(overrides: Partial<Record<keyof GitRunner, string | null>> = {}): GitRunner {
  return {
    remoteUrl: () => overrides.remoteUrl ?? null,
    topLevel: () => overrides.topLevel ?? null,
    currentBranch: () => overrides.currentBranch ?? null,
  }
}

describe('resolveScopes (plan §17.5)', () => {
  it('derives the project key from a git remote owner/repo', () => {
    const git = fakeGit({
      remoteUrl: 'git@github.com:acme/widgets.git',
      topLevel: '/work/widgets',
      currentBranch: 'main',
    })
    const scopes = resolveScopes({ cwd: '/work/widgets', user: 'alice' }, git)

    expect(scopes.project).toEqual({ type: 'project', key: 'acme/widgets' })
    expect(scopes.branch).toEqual({ type: 'branch', key: 'main' })
    expect(scopes.user).toEqual({ type: 'user', key: 'alice' })
    expect(scopes.workspace).toEqual({ type: 'workspace', key: '/work/widgets' })
  })

  it('parses owner/repo from an https remote with a trailing .git', () => {
    const git = fakeGit({ remoteUrl: 'https://github.com/acme/widgets.git' })
    const scopes = resolveScopes({ cwd: '/anything' }, git)
    expect(scopes.project.key).toBe('acme/widgets')
  })

  it('falls back to the git root directory name when there is no remote', () => {
    const git = fakeGit({ topLevel: '/work/my-repo', currentBranch: 'feature/x' })
    const scopes = resolveScopes({ cwd: '/work/my-repo/packages/sub' }, git)

    expect(scopes.project).toEqual({ type: 'project', key: 'my-repo' })
    expect(scopes.branch).toEqual({ type: 'branch', key: 'feature/x' })
  })

  it('falls back to the cwd basename when not a git repo (no throw)', () => {
    const git = fakeGit() // everything null -> not a repo
    const scopes = resolveScopes({ cwd: '/tmp/sandbox' }, git)

    expect(scopes.project).toEqual({ type: 'project', key: 'sandbox' })
    expect(scopes.branch).toBeNull()
  })

  it('parses the current branch and treats a detached HEAD as no branch only via the runner', () => {
    // The runner is responsible for mapping detached HEAD -> null; here the fake
    // already returns the branch name it was given.
    const git = fakeGit({ currentBranch: 'release/2.0' })
    const scopes = resolveScopes({ cwd: '/x' }, git)
    expect(scopes.branch).toEqual({ type: 'branch', key: 'release/2.0' })
  })

  it('maps the provided OpenCode session and agent ids', () => {
    const git = fakeGit()
    const scopes = resolveScopes({ cwd: '/x', sessionId: 'sess-123', agentId: 'claude-opus' }, git)
    expect(scopes.session).toEqual({ type: 'session', key: 'sess-123' })
    expect(scopes.agent).toEqual({ type: 'agent', key: 'claude-opus' })
  })

  it('leaves session/agent null when the runtime supplies none', () => {
    const scopes = resolveScopes({ cwd: '/x' }, fakeGit())
    expect(scopes.session).toBeNull()
    expect(scopes.agent).toBeNull()
  })

  it('defaults the user to the OS user when none is configured', () => {
    const scopes = resolveScopes({ cwd: '/x' }, fakeGit())
    expect(scopes.user.type).toBe('user')
    expect(scopes.user.key.length).toBeGreaterThan(0)
  })

  it('resolves against the real (non-git) repo cwd without throwing', () => {
    // naru-memory itself is not a git repo, so the DEFAULT runner must degrade
    // to the cwd basename and a null branch rather than throwing (plan §17.5).
    const scopes = resolveScopes({ cwd: process.cwd() })
    expect(scopes.project.key).toBe(basename(process.cwd()))
    expect(scopes.workspace.key).toBe(process.cwd())
  })
})

describe('projectKeyFromRemote (plan §17.5)', () => {
  it('handles ssh, scp-like, https, and bare forms', () => {
    expect(projectKeyFromRemote('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(projectKeyFromRemote('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(projectKeyFromRemote('ssh://git@host.xz/acme/widgets')).toBe('acme/widgets')
    expect(projectKeyFromRemote('https://gitlab.com/group/sub/widgets.git')).toBe('sub/widgets')
    expect(projectKeyFromRemote('widgets')).toBe('widgets')
    expect(projectKeyFromRemote('')).toBeNull()
  })
})

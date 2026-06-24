/**
 * Hand-labeled eval fixtures for the relevance/scope quality gate (plan §21.7).
 *
 * The corpus deliberately spans MULTIPLE scopes and seeds near-duplicate facts
 * across them (e.g. a "package manager preference" in two different projects, a
 * personal preference at `user` scope vs a project convention) so that
 * scope-correctness is genuinely testable: a query restricted to one scope must
 * never surface the other scope's lexically-similar fact (plan §9.4, §18.3).
 *
 * Facts are seeded through the real {@link Naru} ADD path and identified by a
 * stable `label`. Fact IDs are ULIDs minted at insert time, so the runner builds
 * a `label -> factId` map at seed time and resolves each case's
 * `expectedLabels` to concrete IDs when scoring (the labels are the checked-in
 * ground truth; the IDs are not).
 *
 * Statements use distinctive, overlapping tokens because the deterministic
 * offline MockEmbedder is a lexical hashing embedding (token overlap drives both
 * BM25 and the vector signal) — exactly the no-network backend the eval requires.
 */

import type { WritableScopeSelector } from '../scope-service'

/** A scope used by the fixture corpus. */
export const SCOPES = {
  userAlice: { type: 'user', key: 'alice' },
  projectApp: { type: 'project', key: 'web-app' },
  projectApi: { type: 'project', key: 'api-svc' },
  sessionWork: { type: 'session', key: 'sess-1' },
} satisfies Record<string, WritableScopeSelector>

/** One seeded fact in the fixture corpus, addressed by a stable `label`. */
export interface FixtureFact {
  /** Stable identifier used by cases to express expected results. */
  label: string
  text: string
  scope: WritableScopeSelector
}

/**
 * The seeded corpus (plan §21.7 retrieval eval). Designed so that:
 *  - several topics recur across scopes (package manager, test runner, deploy)
 *    to exercise scope isolation; and
 *  - each labeled-relevant fact shares distinctive tokens with its query so
 *    lexical + vector retrieval can find it deterministically offline.
 */
export const CORPUS: FixtureFact[] = [
  // --- project: web-app -------------------------------------------------
  {
    label: 'app-pkgmgr',
    text: 'The web-app project uses pnpm as its package manager for installing dependencies',
    scope: SCOPES.projectApp,
  },
  {
    label: 'app-testrunner',
    text: 'The web-app test suite runs with vitest in watch mode during development',
    scope: SCOPES.projectApp,
  },
  {
    label: 'app-deploy',
    text: 'Deploy the web-app frontend to Vercel by pushing to the main branch',
    scope: SCOPES.projectApp,
  },
  {
    label: 'app-style',
    text: 'The web-app uses Tailwind utility classes for component styling',
    scope: SCOPES.projectApp,
  },
  {
    label: 'app-state',
    text: 'The web-app manages client state with Zustand stores instead of Redux',
    scope: SCOPES.projectApp,
  },

  // --- project: api-svc (near-duplicates on purpose) --------------------
  {
    label: 'api-pkgmgr',
    text: 'The api-svc project uses npm as its package manager for installing dependencies',
    scope: SCOPES.projectApi,
  },
  {
    label: 'api-testrunner',
    text: 'The api-svc test suite runs with jest using the node test environment',
    scope: SCOPES.projectApi,
  },
  {
    label: 'api-deploy',
    text: 'Deploy the api-svc backend to Fly.io using the release pipeline on tags',
    scope: SCOPES.projectApi,
  },
  {
    label: 'api-db',
    text: 'The api-svc stores records in PostgreSQL behind a connection pool',
    scope: SCOPES.projectApi,
  },
  {
    label: 'api-auth',
    text: 'The api-svc authenticates requests with short-lived JWT bearer tokens',
    scope: SCOPES.projectApi,
  },

  // --- user: alice (personal preferences) -------------------------------
  {
    label: 'alice-editor',
    text: 'Alice prefers the dark theme in her code editor for long sessions',
    scope: SCOPES.userAlice,
  },
  {
    label: 'alice-shell',
    text: 'Alice uses the zsh shell with starship prompt on her laptop',
    scope: SCOPES.userAlice,
  },
  {
    label: 'alice-pkgmgr',
    text: 'Alice personally prefers pnpm as her package manager across all projects',
    scope: SCOPES.userAlice,
  },
  {
    label: 'alice-coffee',
    text: 'Alice drinks pour-over coffee and avoids meetings before ten in the morning',
    scope: SCOPES.userAlice,
  },

  // --- session: sess-1 (ephemeral working context) ----------------------
  {
    label: 'sess-bug',
    text: 'The current session is debugging a flaky timeout in the checkout integration test',
    scope: SCOPES.sessionWork,
  },
  {
    label: 'sess-branch',
    text: 'Working on the feature branch for the new onboarding wizard in this session',
    scope: SCOPES.sessionWork,
  },
]

/**
 * A labeled retrieval case (plan §21.7): a query, the allowed read scope(s), and
 * the labels of the facts that SHOULD be returned (resolved to IDs by the
 * runner). `allowedScopeKeys` is the precomputed set of allowed `type:key`
 * strings used by the scope-correctness gate.
 */
export interface RetrievalCase {
  name: string
  query: string
  /** Allowed read scope set (mirrors the search `scopes` selector). */
  scopes: WritableScopeSelector[]
  /** Labels of the expected-relevant facts within the allowed scopes. */
  expectedLabels: string[]
}

/** Allowed scope keys (`type:key`) for a case's scope selectors. */
export function allowedScopeKeys(scopes: WritableScopeSelector[]): Set<string> {
  return new Set(scopes.map((s) => `${s.type}:${s.key}`))
}

/**
 * The labeled retrieval cases. Each case names the scope it reads and the facts
 * that must come back. Cross-scope near-duplicates (e.g. `alice-pkgmgr` vs
 * `app-pkgmgr`) are intentionally OUT of scope for single-scope cases so any leak
 * shows up as both a precision drop and a scope-correctness failure.
 */
export const RETRIEVAL_CASES: RetrievalCase[] = [
  {
    name: 'package manager in web-app project only',
    query: 'which package manager does this project use',
    scopes: [SCOPES.projectApp],
    expectedLabels: ['app-pkgmgr'],
  },
  {
    name: 'package manager in api-svc project only',
    query: 'package manager for installing dependencies',
    scopes: [SCOPES.projectApi],
    expectedLabels: ['api-pkgmgr'],
  },
  {
    name: 'test runner in web-app',
    query: 'how do we run the test suite',
    scopes: [SCOPES.projectApp],
    expectedLabels: ['app-testrunner'],
  },
  {
    name: 'test runner in api-svc',
    query: 'test suite test runner environment',
    scopes: [SCOPES.projectApi],
    expectedLabels: ['api-testrunner'],
  },
  {
    name: 'deploy target for web-app',
    query: 'how do we deploy the frontend',
    scopes: [SCOPES.projectApp],
    expectedLabels: ['app-deploy'],
  },
  {
    name: 'deploy target for api-svc',
    query: 'deploy the backend release pipeline',
    scopes: [SCOPES.projectApi],
    expectedLabels: ['api-deploy'],
  },
  {
    name: 'styling approach in web-app',
    query: 'component styling utility classes',
    scopes: [SCOPES.projectApp],
    expectedLabels: ['app-style'],
  },
  {
    name: 'state management in web-app',
    query: 'how is client state managed',
    scopes: [SCOPES.projectApp],
    expectedLabels: ['app-state'],
  },
  {
    name: 'database used by api-svc',
    query: 'where does the service store records database',
    scopes: [SCOPES.projectApi],
    expectedLabels: ['api-db'],
  },
  {
    name: 'authentication in api-svc',
    query: 'how are requests authenticated bearer tokens',
    scopes: [SCOPES.projectApi],
    expectedLabels: ['api-auth'],
  },
  {
    name: 'editor preference for alice',
    query: 'what theme does alice prefer in her editor',
    scopes: [SCOPES.userAlice],
    expectedLabels: ['alice-editor'],
  },
  {
    name: 'shell preference for alice',
    query: 'which shell and prompt does alice use',
    scopes: [SCOPES.userAlice],
    expectedLabels: ['alice-shell'],
  },
  {
    name: 'personal package manager preference for alice',
    query: 'package manager alice prefers across projects',
    scopes: [SCOPES.userAlice],
    expectedLabels: ['alice-pkgmgr'],
  },
  {
    name: 'current session bug',
    query: 'flaky timeout checkout integration test',
    scopes: [SCOPES.sessionWork],
    expectedLabels: ['sess-bug'],
  },
  {
    name: 'current session branch',
    query: 'feature branch onboarding wizard',
    scopes: [SCOPES.sessionWork],
    expectedLabels: ['sess-branch'],
  },
  {
    // Multi-scope read: both projects in the allowed set. A package-manager
    // query should surface BOTH project package-manager facts (and may include
    // alice's only if alice scope were allowed — it is not here).
    name: 'package manager across both projects',
    query: 'package manager for installing dependencies',
    scopes: [SCOPES.projectApp, SCOPES.projectApi],
    expectedLabels: ['app-pkgmgr', 'api-pkgmgr'],
  },
  {
    // Cross-scope isolation probe: query strongly matches alice-pkgmgr by
    // tokens, but only the web-app project scope is allowed. The expected result
    // is the project fact; alice's near-duplicate MUST NOT leak in.
    name: 'package manager query restricted to web-app (alice must not leak)',
    query: 'prefers pnpm as package manager across all projects',
    scopes: [SCOPES.projectApp],
    expectedLabels: ['app-pkgmgr'],
  },
]

/**
 * Golden extraction fixtures (plan §21.7 extraction eval): an episode plus the
 * minimum number of distinct facts the deterministic MockExtractor should yield
 * and key terms (proper nouns / tools) that must be preserved in the extracted
 * statements (the §13.2 proper-noun/number preservation rules).
 */
export interface ExtractionCase {
  name: string
  episode: string
  scope: WritableScopeSelector
  /** Minimum number of distinct active facts capture() should produce. */
  expectedMinFacts: number
  /** Terms (lowercased compare) that must survive into some extracted statement. */
  keyTerms: string[]
}

export const EXTRACTION_CASES: ExtractionCase[] = [
  {
    name: 'preference + tool are preserved',
    episode: 'I prefer pnpm over npm. We deploy the web-app to Vercel on every merge.',
    scope: SCOPES.projectApp,
    expectedMinFacts: 1,
    keyTerms: ['pnpm'],
  },
  {
    name: 'proper nouns preserved across sentences',
    episode: 'The api-svc uses PostgreSQL for storage. Authentication is handled with JWT tokens.',
    scope: SCOPES.projectApi,
    expectedMinFacts: 1,
    keyTerms: ['postgresql'],
  },
  {
    name: 'personal preference captured',
    episode: 'Alice prefers the dark theme and uses the zsh shell on her laptop.',
    scope: SCOPES.userAlice,
    expectedMinFacts: 1,
    keyTerms: ['alice'],
  },
]

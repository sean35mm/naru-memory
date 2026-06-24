/**
 * Eval harness (plan §21.7): seed the labeled fixture corpus, run each case
 * through the REAL hybrid scope-safe search, and compute relevance/scope metrics.
 *
 * Everything is offline and deterministic: the corpus is embedded with the
 * MockEmbedder (no network) and queried via {@link Naru.searchHybrid} so the
 * full §14 pipeline (scope resolution -> FTS + entity + vector KNN -> current
 * view -> weighted-linear rank) is exercised end to end. The reported scores are
 * the ground truth used to assert the gate thresholds in `eval.test.ts` and to
 * tune the ranking weights (plan §14.2).
 */

import { Naru } from '../naru'
import {
  CORPUS,
  EXTRACTION_CASES,
  type ExtractionCase,
  RETRIEVAL_CASES,
  type RetrievalCase,
  allowedScopeKeys,
} from './fixtures'
import { mean, precisionAtK, recallAtK, reciprocalRank, scopeCorrectness } from './metrics'

/** Per-case retrieval scores (plan §21.7). */
export interface CaseResult {
  name: string
  recallAtK: number
  precisionAtK: number
  /**
   * Precision@1: is the TOP result relevant? This is the meaningful precision
   * signal for this corpus — precision@k is mechanically diluted because each
   * scope holds several in-scope facts but a case usually expects exactly one,
   * so the other in-scope (correct, non-leaking) facts count as "not expected".
   */
  precisionAt1: number
  reciprocalRank: number
  scopeCorrectness: number
  /** Number of results returned (used to pool the global scope-correctness gate). */
  returnedCount: number
  /** Number of returned results that were in an allowed scope. */
  inScopeCount: number
  /** Labels of expected facts not returned within `k` (for debugging misses). */
  missedLabels: string[]
}

/** Aggregate retrieval-eval report over all cases (plan §21.7). */
export interface EvalReport {
  k: number
  cases: CaseResult[]
  /** Mean recall@k across cases. */
  meanRecallAtK: number
  /** Mean precision@k across cases. */
  meanPrecisionAtK: number
  /** Mean precision@1 across cases (the meaningful top-result precision bar). */
  meanPrecisionAt1: number
  /** Mean reciprocal rank across cases (MRR). */
  mrr: number
  /**
   * Overall scope-correctness rate (plan §18.3 HARD gate): pooled across every
   * returned result of every case. MUST be 1.0 — any value below means a
   * cross-scope leak occurred.
   */
  scopeCorrectness: number
}

/** Seed the fixture corpus into a fresh in-memory Naru and embed all vectors. */
export async function seedCorpus(): Promise<{
  naru: Naru
  /** label -> minted fact id, for resolving each case's expected set. */
  idByLabel: Map<string, string>
}> {
  const naru = Naru.open({ db: ':memory:', embeddings: { provider: 'mock' } })
  const idByLabel = new Map<string, string>()
  for (const fact of CORPUS) {
    const inserted = naru.addMemory({ text: fact.text, scope: fact.scope })
    idByLabel.set(fact.label, inserted.id)
  }
  // addMemory embeds fire-and-forget after its sync commit; reindex deterministically
  // populates every vector so searchHybrid's vector signal is available.
  await naru.reindexVectors()
  return { naru, idByLabel }
}

/** Run one retrieval case against a seeded corpus and score it. */
export async function runRetrievalCase(
  naru: Naru,
  idByLabel: Map<string, string>,
  testCase: RetrievalCase,
  k: number,
): Promise<CaseResult> {
  const relevantIds = new Set(
    testCase.expectedLabels.map((label) => {
      const id = idByLabel.get(label)
      if (!id) {
        throw new Error(`eval fixture: unknown label "${label}" in case "${testCase.name}"`)
      }
      return id
    }),
  )
  // Real scope-safe hybrid search: scopes are resolved BEFORE candidate
  // retrieval, KNN/FTS/entity are restricted to the allowed scope set.
  const results = await naru.searchHybrid({
    scopes: testCase.scopes,
    query: testCase.query,
    limit: k,
  })
  const returnedIds = results.map((r) => r.factId)
  const returnedScopes = results.map((r) => r.scope)
  const allowed = allowedScopeKeys(testCase.scopes)
  const inScopeCount = returnedScopes.filter((s) => allowed.has(s)).length

  const missedLabels = testCase.expectedLabels.filter(
    (label) => !returnedIds.slice(0, k).includes(idByLabel.get(label) ?? ''),
  )

  return {
    name: testCase.name,
    recallAtK: recallAtK(returnedIds, relevantIds, k),
    precisionAtK: precisionAtK(returnedIds, relevantIds, k),
    precisionAt1: precisionAtK(returnedIds, relevantIds, 1),
    reciprocalRank: reciprocalRank(returnedIds, relevantIds),
    scopeCorrectness: scopeCorrectness(returnedScopes, allowed),
    returnedCount: returnedScopes.length,
    inScopeCount,
    missedLabels,
  }
}

/**
 * Run the full retrieval eval and aggregate (plan §21.7). Seeds a corpus, runs
 * every {@link RETRIEVAL_CASES} case at top-`k`, and returns the report. The
 * `scopeCorrectness` field is pooled over EVERY returned result so a single leak
 * anywhere drops it below 1.0.
 */
export async function runRetrievalEval(k = 5): Promise<EvalReport> {
  const { naru, idByLabel } = await seedCorpus()
  try {
    const cases: CaseResult[] = []
    let totalReturned = 0
    let totalInScope = 0
    for (const testCase of RETRIEVAL_CASES) {
      const result = await runRetrievalCase(naru, idByLabel, testCase, k)
      cases.push(result)
      // Pool raw in-scope counts across every case for the global scope gate.
      totalReturned += result.returnedCount
      totalInScope += result.inScopeCount
    }
    return {
      k,
      cases,
      meanRecallAtK: mean(cases.map((c) => c.recallAtK)),
      meanPrecisionAtK: mean(cases.map((c) => c.precisionAtK)),
      meanPrecisionAt1: mean(cases.map((c) => c.precisionAt1)),
      mrr: mean(cases.map((c) => c.reciprocalRank)),
      scopeCorrectness: totalReturned === 0 ? 1 : totalInScope / totalReturned,
    }
  } finally {
    naru.close()
  }
}

/** Per-case extraction scores (plan §21.7 extraction eval). */
export interface ExtractionResult {
  name: string
  factCount: number
  expectedMinFacts: number
  /** Key terms that were NOT preserved in any extracted statement. */
  missingTerms: string[]
}

/**
 * Run the golden extraction cases (plan §21.7): capture each episode through the
 * deterministic MockExtractor and check fact count + proper-noun/term
 * preservation (§13.2). Offline, no network.
 */
export async function runExtractionEval(): Promise<ExtractionResult[]> {
  const naru = Naru.open({ db: ':memory:', llm: { provider: 'mock' } })
  try {
    const results: ExtractionResult[] = []
    for (const testCase of EXTRACTION_CASES) {
      const result = await runExtractionCase(naru, testCase)
      results.push(result)
    }
    return results
  } finally {
    naru.close()
  }
}

/** Capture one episode and score its extracted facts. */
async function runExtractionCase(naru: Naru, testCase: ExtractionCase): Promise<ExtractionResult> {
  const { facts } = await naru.capture({ text: testCase.episode, scope: testCase.scope })
  const haystack = facts.map((f) => f.statement.toLowerCase()).join('  ')
  const missingTerms = testCase.keyTerms.filter((term) => !haystack.includes(term.toLowerCase()))
  return {
    name: testCase.name,
    factCount: facts.length,
    expectedMinFacts: testCase.expectedMinFacts,
    missingTerms,
  }
}

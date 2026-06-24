import { describe, expect, it } from 'vitest'
import { EXTRACTION_CASES, RETRIEVAL_CASES } from './fixtures'
import { precisionAtK, recallAtK, reciprocalRank, scopeCorrectness } from './metrics'
import { runExtractionEval, runRetrievalEval } from './runner'

/**
 * Quality-eval gate (plan §21.7): the relevance/scope CI gate the plan requires.
 *
 * Seeds a multi-scope labeled corpus with the deterministic offline MockEmbedder
 * (no network), runs every labeled case through the REAL hybrid scope-safe search
 * (plan §14), and asserts calibrated relevance thresholds plus the §18.3 HARD
 * scope-correctness gate (exactly 1.0 — any cross-scope leak fails the build).
 *
 * Thresholds are calibrated to the checked-in fixture corpus, NOT guessed:
 *  - recall@5 measured 1.0  -> gate >= 0.95
 *  - precision@1 measured 1.0 (top result always correct) -> gate >= 0.9
 *    (precision@k>1 is intentionally NOT gated: each scope holds several correct,
 *     non-leaking facts but a case expects ~one, so precision@5 is diluted by
 *     design — see CaseResult.precisionAt1)
 *  - MRR measured 1.0 -> gate >= 0.9
 *  - scope-correctness measured 1.0 -> gate === 1.0 (HARD, plan §18.3)
 */

const K = 5
const RECALL_AT_K_BAR = 0.95
const PRECISION_AT_1_BAR = 0.9
const MRR_BAR = 0.9

describe('retrieval quality gate (plan §21.7)', () => {
  it('meets recall@5 / precision@1 / MRR bars and leaks zero cross-scope results', async () => {
    const report = await runRetrievalEval(K)

    // Relevance bars (calibrated to the fixture corpus).
    expect(report.meanRecallAtK).toBeGreaterThanOrEqual(RECALL_AT_K_BAR)
    expect(report.meanPrecisionAt1).toBeGreaterThanOrEqual(PRECISION_AT_1_BAR)
    expect(report.mrr).toBeGreaterThanOrEqual(MRR_BAR)

    // HARD GATE (plan §18.3): pooled scope-correctness over EVERY returned
    // result of EVERY case must be exactly 1.0 — a single leak fails the build.
    expect(report.scopeCorrectness).toBe(1)

    // And per-case, so a failure points at the offending query.
    for (const c of report.cases) {
      expect(c.scopeCorrectness, `scope leak in case: ${c.name}`).toBe(1)
    }
  })

  it('returns every expected fact within k for each case (no silent misses)', async () => {
    const report = await runRetrievalEval(K)
    for (const c of report.cases) {
      expect(c.missedLabels, `missed expected facts in case: ${c.name}`).toEqual([])
    }
  })

  it('has a corpus large enough to exercise scope isolation', () => {
    // The gate is only meaningful with multiple scopes and enough labeled cases.
    expect(RETRIEVAL_CASES.length).toBeGreaterThanOrEqual(15)
    const scopeKeys = new Set(
      RETRIEVAL_CASES.flatMap((c) => c.scopes.map((s) => `${s.type}:${s.key}`)),
    )
    expect(scopeKeys.size).toBeGreaterThanOrEqual(3)
  })
})

describe('extraction quality gate (plan §21.7 extraction eval)', () => {
  it('produces the expected fact count and preserves key terms (proper nouns/tools)', async () => {
    const results = await runExtractionEval()
    expect(results.length).toBe(EXTRACTION_CASES.length)
    for (const r of results) {
      expect(r.factCount, `too few facts in: ${r.name}`).toBeGreaterThanOrEqual(r.expectedMinFacts)
      // §13.2 proper-noun/number preservation: no key term may be dropped.
      expect(r.missingTerms, `dropped key terms in: ${r.name}`).toEqual([])
    }
  })
})

describe('metric primitives', () => {
  it('recall@k counts relevant hits within the top k', () => {
    const relevant = new Set(['a', 'b'])
    expect(recallAtK(['a', 'x', 'b'], relevant, 3)).toBe(1)
    expect(recallAtK(['a', 'x', 'b'], relevant, 1)).toBe(0.5)
    expect(recallAtK(['x', 'y'], relevant, 2)).toBe(0)
  })

  it('precision@k counts relevant among the top k actually returned', () => {
    const relevant = new Set(['a'])
    expect(precisionAtK(['a', 'x'], relevant, 2)).toBe(0.5)
    expect(precisionAtK(['a'], relevant, 1)).toBe(1)
    // No results returned -> no false positives.
    expect(precisionAtK([], relevant, 5)).toBe(1)
  })

  it('reciprocal rank is 1/(rank of first relevant), 1-indexed', () => {
    const relevant = new Set(['b'])
    expect(reciprocalRank(['a', 'b', 'c'], relevant)).toBe(0.5)
    expect(reciprocalRank(['b'], relevant)).toBe(1)
    expect(reciprocalRank(['x', 'y'], relevant)).toBe(0)
  })

  it('scope-correctness is the in-scope fraction; 1.0 means zero leaks', () => {
    const allowed = new Set(['project:app'])
    expect(scopeCorrectness(['project:app', 'project:app'], allowed)).toBe(1)
    expect(scopeCorrectness(['project:app', 'user:alice'], allowed)).toBe(0.5)
    expect(scopeCorrectness([], allowed)).toBe(1)
  })
})

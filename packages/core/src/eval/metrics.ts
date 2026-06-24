/**
 * Retrieval-quality metrics for the labeled eval gate (plan §21.7).
 *
 * All metrics operate on an ORDERED list of returned fact IDs (rank 0 first) and
 * a set of relevant (expected) fact IDs. They are pure and deterministic so the
 * eval test can assert exact thresholds. `scopeCorrectness` is the §18.3 hard
 * gate: it scores the fraction of returned results whose scope is in the allowed
 * set — anything below 1.0 means a cross-scope leak and is a hard FAIL.
 */

/**
 * Recall@k: fraction of the relevant set that appears in the top-`k` returned
 * IDs (plan §21.7). 1.0 when every expected fact is retrieved within `k`.
 * Returns 1 for an empty relevant set (nothing to recall — vacuously complete).
 */
export function recallAtK(returnedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) {
    return 1
  }
  const topK = returnedIds.slice(0, k)
  let hits = 0
  for (const id of relevantIds) {
    if (topK.includes(id)) {
      hits++
    }
  }
  return hits / relevantIds.size
}

/**
 * Precision@k: fraction of the top-`k` returned IDs that are relevant (plan
 * §21.7). Normalized by the number actually returned within `k` (so a query that
 * returns fewer than `k` results is not penalized for the empty slots). Returns 1
 * when nothing was returned (no false positives possible).
 */
export function precisionAtK(returnedIds: string[], relevantIds: Set<string>, k: number): number {
  const topK = returnedIds.slice(0, k)
  if (topK.length === 0) {
    return 1
  }
  let hits = 0
  for (const id of topK) {
    if (relevantIds.has(id)) {
      hits++
    }
  }
  return hits / topK.length
}

/**
 * Mean reciprocal rank contribution for ONE query (plan §21.7 ranking quality):
 * 1 / (rank of the first relevant result), 1-indexed; 0 when no relevant result
 * is returned. Average these across queries to get MRR.
 */
export function reciprocalRank(returnedIds: string[], relevantIds: Set<string>): number {
  for (let i = 0; i < returnedIds.length; i++) {
    const id = returnedIds[i]
    if (id !== undefined && relevantIds.has(id)) {
      return 1 / (i + 1)
    }
  }
  return 0
}

/**
 * Scope-correctness rate (plan §18.3 / §21.7 HARD gate): fraction of returned
 * results whose scope key is in the allowed scope set. MUST be 1.0 — any
 * out-of-scope result is a cross-scope leak and a hard FAIL. Returns 1 for an
 * empty result list (no leak possible).
 *
 * `returnedScopes` is the scope key (`type:key`) of each returned result, in
 * the same order as the returned IDs.
 */
export function scopeCorrectness(returnedScopes: string[], allowedScopeKeys: Set<string>): number {
  if (returnedScopes.length === 0) {
    return 1
  }
  let inScope = 0
  for (const scope of returnedScopes) {
    if (allowedScopeKeys.has(scope)) {
      inScope++
    }
  }
  return inScope / returnedScopes.length
}

/** Arithmetic mean of a list of numbers; 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  let sum = 0
  for (const v of values) {
    sum += v
  }
  return sum / values.length
}

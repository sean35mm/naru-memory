/**
 * Quality-eval gate barrel (plan §21.7): labeled fixtures, retrieval/scope
 * metrics, and the offline runner. Imported by `eval.test.ts` (the CI gate) and
 * reusable by tooling that needs the same metrics over a different corpus.
 */
export * from './fixtures'
export * from './metrics'
export * from './runner'

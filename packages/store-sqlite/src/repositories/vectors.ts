import type Database from 'better-sqlite3'

/**
 * One stored fact vector (plan §11.9). The vector is materialized as a
 * `Float32Array` for in-JS cosine math; on disk it is a little-endian Float32
 * BLOB (see {@link float32ToBlob}).
 */
export interface FactVector {
  factId: string
  provider: string
  model: string
  dimension: number
  vector: Float32Array
  sourceHash: string
  createdAt: string
}

/** Arguments for {@link VectorRepository.upsertVector}. */
export interface UpsertVectorInput {
  provider: string
  model: string
  dimension: number
  vector: Float32Array
  sourceHash: string
}

/** A KNN hit: the fact id and its cosine similarity to the query vector. */
export interface VectorKnnHit {
  factId: string
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number
}

/**
 * Optional vector-identity guard for {@link VectorRepository.knn}. When supplied,
 * only vectors stored under this exact `provider` + `model` are scored, so a
 * model change forces a re-embed rather than silently mixing two same-dimension
 * models' vectors into one cosine ranking (plan §11.9). Omit to score every
 * in-scope vector of the query's dimension (legacy behavior).
 */
export interface VectorKnnMatch {
  provider: string
  model: string
}

/** L2 norm (magnitude) of a vector. */
function magnitude(vec: Float32Array): number {
  let sumSq = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0
    sumSq += v * v
  }
  return Math.sqrt(sumSq)
}

/** A `fact_vectors` row joined to the owning fact's scope/status for KNN. */
interface CandidateRow {
  fact_id: string
  vector: Buffer
}

/**
 * Serialize a `Float32Array` to a little-endian Float32 BLOB for storage.
 *
 * A copy is taken so the BLOB is exactly `dimension * 4` bytes regardless of the
 * source array's `byteOffset`/`buffer` slack (a subarray view can share a larger
 * ArrayBuffer). `better-sqlite3` binds a `Buffer` as a BLOB.
 */
function float32ToBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

/**
 * Decode a stored little-endian Float32 BLOB back to a `Float32Array`.
 *
 * Copies into a fresh aligned `ArrayBuffer` so the result is independent of the
 * backing `Buffer` (whose `byteOffset` may be non-zero and whose memory pool may
 * be reused) and is guaranteed 4-byte aligned for the `Float32Array` view.
 */
function blobToFloat32(blob: Buffer): Float32Array {
  const bytes = blob.byteLength - (blob.byteLength % 4)
  const out = new Float32Array(bytes / 4)
  for (let i = 0; i < out.length; i++) {
    out[i] = blob.readFloatLE(i * 4)
  }
  return out
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 when either vector
 * has zero magnitude (undefined direction) so a degenerate vector never ranks.
 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) {
    return 0
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Persistence for fact embedding vectors plus brute-force cosine KNN (plan
 * §11.9, §14.1 vector candidates). Vectors are stored as little-endian Float32
 * BLOBs and 1:1 with facts (`fact_id` PK). KNN is exact brute-force cosine in
 * JS — correct and fine for the 1k/10k benchmark sizes (plan §21.6) — with a
 * capability seam for an accelerated backend later (plan §12.2).
 *
 * SCOPE SAFETY (plan §9.4, §18.3): {@link knn} filters candidate vectors to the
 * allowed scope set AND `status = 'active'` IN THE SQL that selects rows, before
 * any scoring. Vector similarity can never pull a fact from a foreign scope or a
 * superseded/deleted fact into the result set.
 */
export class VectorRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert or replace the vector for a fact (1:1, plan §11.9). Re-embedding a
   * fact (new model or refreshed source) overwrites in place. The BLOB is a
   * little-endian Float32 copy sized exactly to the vector's bytes.
   */
  upsertVector(factId: string, input: UpsertVectorInput): void {
    this.db
      .prepare(
        `INSERT INTO fact_vectors
           (fact_id, provider, model, dimension, vector, source_hash, created_at)
         VALUES
           (@factId, @provider, @model, @dimension, @vector, @sourceHash, @createdAt)
         ON CONFLICT(fact_id) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           dimension = excluded.dimension,
           vector = excluded.vector,
           source_hash = excluded.source_hash,
           created_at = excluded.created_at`,
      )
      .run({
        factId,
        provider: input.provider,
        model: input.model,
        dimension: input.dimension,
        vector: float32ToBlob(input.vector),
        sourceHash: input.sourceHash,
        createdAt: new Date().toISOString(),
      })
  }

  /** Remove a fact's vector (used by forget/unindex paths, plan §18.2). */
  deleteVector(factId: string): void {
    this.db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(factId)
  }

  /** Fetch a stored vector for a fact, decoded to a `Float32Array`. */
  getVector(factId: string): FactVector | undefined {
    const row = this.db.prepare('SELECT * FROM fact_vectors WHERE fact_id = ?').get(factId) as
      | {
          fact_id: string
          provider: string
          model: string
          dimension: number
          vector: Buffer
          source_hash: string
          created_at: string
        }
      | undefined
    if (!row) {
      return undefined
    }
    return {
      factId: row.fact_id,
      provider: row.provider,
      model: row.model,
      dimension: row.dimension,
      vector: blobToFloat32(row.vector),
      sourceHash: row.source_hash,
      createdAt: row.created_at,
    }
  }

  /**
   * Brute-force cosine KNN over the vectors of ACTIVE facts within the allowed
   * scope set (plan §9.4 safe pattern). The scope + status filter is applied in
   * the SELECT (joining `fact_vectors` to `facts` and `scopes`), so only
   * in-scope, active candidates are ever scored. Returns the top `k` by cosine
   * similarity, highest first. Returns [] for an empty scope set or `k <= 0`.
   *
   * Candidate vectors whose stored dimension differs from the query vector are
   * skipped (a stale-model vector can't be compared meaningfully); when `match`
   * is supplied, candidates from a different provider/model are skipped too.
   *
   * A zero-magnitude query vector (no direction, e.g. token-less query text)
   * carries no semantic signal and would score every candidate at cosine 0, so
   * it is treated as "no vector signal" and returns [] (matches lexical search's
   * empty result for the same input rather than surfacing the whole corpus).
   */
  knn(
    scopeKeys: string[],
    queryVec: Float32Array,
    k: number,
    match?: VectorKnnMatch,
  ): VectorKnnHit[] {
    if (scopeKeys.length === 0 || k <= 0 || queryVec.length === 0 || magnitude(queryVec) === 0) {
      return []
    }
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const matchClause = match ? ' AND fv.provider = ? AND fv.model = ?' : ''
    const matchParams = match ? [match.provider, match.model] : []
    const rows = this.db
      .prepare(
        `SELECT fv.fact_id AS fact_id, fv.vector AS vector
           FROM fact_vectors fv
           JOIN facts f ON f.id = fv.fact_id
           JOIN scopes s ON s.id = f.scope_id
          WHERE f.status = 'active'
            AND fv.dimension = ?${matchClause}
            AND s.key IN (${placeholders})`,
      )
      .all(queryVec.length, ...matchParams, ...scopeKeys) as CandidateRow[]

    const scored: VectorKnnHit[] = []
    for (const row of rows) {
      const vec = blobToFloat32(row.vector)
      scored.push({ factId: row.fact_id, score: cosine(queryVec, vec) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  /** Number of stored vectors (used by capability detection / status). */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM fact_vectors').get() as { n: number }
    return row.n
  }

  /** Drop all vectors so the index can be rebuilt from canonical facts (plan §12.2). */
  clearVectors(): void {
    this.db.exec('DELETE FROM fact_vectors')
  }
}

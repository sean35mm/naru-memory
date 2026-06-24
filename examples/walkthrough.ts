/**
 * Naru Memory — end-to-end walkthrough / smoke demo.
 *
 * Drives the real embedded `Naru` facade against a throwaway temp database and
 * narrates each Milestone-1 capability, asserting the key invariants as it goes.
 * It is BOTH a living demo (run: `pnpm demo`) and a self-checking test — any
 * broken invariant throws and the process exits non-zero.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Naru } from '@naru/core'

// ---- tiny console helpers (no deps) ----------------------------------------
let step = 0
function section(title: string): void {
  step += 1
  console.log(`\n${'━'.repeat(74)}`)
  console.log(`  ${step}. ${title}`)
  console.log('━'.repeat(74))
}
function note(msg: string): void {
  console.log(`   • ${msg}`)
}
function check(label: string, cond: boolean): void {
  if (!cond) {
    console.log(`   ✗ FAILED: ${label}`)
    throw new Error(`walkthrough assertion failed: ${label}`)
  }
  console.log(`   ✓ ${label}`)
}

// ---- setup -----------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'naru-demo-'))
const dbPath = join(dir, 'demo.db')
const naru = Naru.open({ db: dbPath })
console.log(`\nNaru Memory walkthrough  (throwaway db: ${dbPath})`)

try {
  // 1. SCOPES ----------------------------------------------------------------
  section('Scopes — typed boundaries for what gets remembered where (plan §9)')
  const user = naru.ensureScope('user', 'alice')
  const proj = naru.ensureScope('project', 'acme')
  const branch = naru.ensureScope('branch', 'feature-auth')
  note(`created scopes: ${user.key}, ${proj.key}, ${branch.key}`)
  note('every memory is read/written inside an explicit scope')

  // 2. ADD -------------------------------------------------------------------
  section('Add memories (manual, infer=false) — the M1 write path (plan §13.3)')
  const f1 = naru.addMemory({
    text: 'User prefers dark mode and 2-space indentation',
    scope: { type: 'user', key: 'alice' },
  })
  const f2 = naru.addMemory({
    text: 'Acme API uses tRPC and Zod for contracts',
    scope: { type: 'project', key: 'acme' },
    confidence: 0.9,
  })
  const f3 = naru.addMemory({
    text: 'Primary datastore is Postgres 16 via Prisma',
    scope: { type: 'project', key: 'acme' },
  })
  for (const f of [f1, f2, f3]) {
    console.log(`   + ${f.id}  [${f.status}, conf=${f.confidence}]`)
    console.log(`       "${f.statement}"`)
    console.log(
      `       hash=${f.statementHash.slice(0, 16)}…  (portable + deterministic — plan §11.5)`,
    )
  }

  // 3. REDACTION -------------------------------------------------------------
  section('Redaction — secrets & PII scrubbed BEFORE persistence (plan §18.1)')
  const raw = 'Deploy key ghp_ABCDEF1234567890ABCDEFGHIJKLMNOP01 — ping ops@acme.io'
  const fr = naru.addMemory({ text: raw, scope: { type: 'project', key: 'acme' } })
  note(`input : ${raw}`)
  note(`stored: ${fr.statement}`)
  check('raw GitHub token never reaches the DB', !fr.statement.includes('ghp_ABCDEF1234567890'))
  check('raw email never reaches the DB', !fr.statement.includes('ops@acme.io'))

  // 4. DEDUP -----------------------------------------------------------------
  section('Deduplication — same statement in same scope is idempotent (plan §13.5)')
  const dup = naru.addMemory({
    text: 'Primary datastore is Postgres 16 via Prisma',
    scope: { type: 'project', key: 'acme' },
  })
  note(`first add → ${f3.id}`)
  note(`re-add    → ${dup.id}`)
  check('re-adding the same statement returns the SAME fact (no duplicate row)', dup.id === f3.id)

  // 5. SEARCH + SCOPE ISOLATION ---------------------------------------------
  section('Search — scope-filtered FTS/BM25 with ranking reasons (plan §14, §9.4)')
  const hits = naru.search({ query: 'Postgres', scope: { type: 'project', key: 'acme' } })
  for (const h of hits) {
    console.log(`   ${h.score.toFixed(3)}  [${h.scope}]  ${h.statement}`)
    console.log(`           reasons: ${h.reasons.join(', ')}`)
  }
  check(
    'found the Postgres fact in project:acme',
    hits.some((h) => h.factId === f3.id),
  )

  const leak = naru.search({ query: 'Postgres', scope: { type: 'user', key: 'alice' } })
  note(`same query, scope user:alice → ${leak.length} result(s)`)
  check('SCOPE ISOLATION — the project fact does NOT leak into the user scope', leak.length === 0)

  const noScope = naru.search({ query: 'Postgres' })
  note(`same query, NO scope given → ${noScope.length} result(s)`)
  check(
    'FAIL-SAFE — broad reads need explicit scope/global, so no-scope returns nothing (§9.4)',
    noScope.length === 0,
  )

  const global = naru.search({ query: 'tRPC', global: true })
  note(`global search "tRPC" → ${global.length} result(s)`)
  check(
    "--global searches across the user's scopes",
    global.some((h) => h.factId === f2.id),
  )

  // 6. SUPERSESSION + CURRENT VIEW ------------------------------------------
  section('Supersession — non-destructive updates + current view (plan §13.6, §14.3)')
  const oldAuth = naru.addMemory({
    text: 'Auth uses server-side session cookies',
    scope: { type: 'branch', key: 'feature-auth' },
  })
  const newAuth = naru.addMemory({
    text: 'Auth migrated to JWT bearer tokens with 15-minute expiry',
    scope: { type: 'branch', key: 'feature-auth' },
  })
  naru.supersede(oldAuth.id, newAuth.id, 'migrated cookies → JWT')
  note(`superseded ${oldAuth.id}  →  ${newAuth.id}`)

  const current = naru.search({ query: 'auth', scope: { type: 'branch', key: 'feature-auth' } })
  note(`current-view search "auth": [${current.map((h) => h.statement).join('  |  ')}]`)
  check(
    'current view returns the NEW fact',
    current.some((h) => h.factId === newAuth.id),
  )
  check('current view HIDES the superseded fact', !current.some((h) => h.factId === oldAuth.id))

  const withHist = naru.search({
    query: 'auth',
    scope: { type: 'branch', key: 'feature-auth' },
    includeHistory: true,
  })
  check(
    'includeHistory surfaces the superseded fact again',
    withHist.some((h) => h.factId === oldAuth.id),
  )

  console.log('   supersession chain for the new fact:')
  for (const e of naru.history(newAuth.id)) {
    console.log(
      `     - ${e.fact.id} [${e.fact.status}]  supersedes=${e.supersedes ?? '∅'}  supersededBy=${e.supersededBy ?? '∅'}`,
    )
  }

  // 7. LIST + GET ------------------------------------------------------------
  section('List & Get — inspect what is remembered (plan §15.2)')
  const active = naru.list({ scope: { type: 'project', key: 'acme' }, status: 'active' })
  note(`active facts in project:acme: ${active.length}`)
  for (const f of active) console.log(`     - ${f.statement}`)
  const got = naru.get(f2.id)
  check('get() returns the fact plus its evidence', !!got && got.fact.id === f2.id)
  note(`get(${f2.id}) → ${got?.evidence.length ?? 0} evidence row(s)`)

  // 8. FORGET (destructive purge incl. derived FTS) -------------------------
  section('Forget — destructive privacy purge of canonical + derived state (plan §18.2)')
  check(
    'Postgres fact is searchable before forget',
    naru.search({ query: 'Postgres', scope: { type: 'project', key: 'acme' } }).length > 0,
  )
  const del = naru.forget({ factId: f3.id })
  note(`forget(factId=${f3.id}) → deleted ${del.deleted}`)
  check(
    'after forget it is gone from search (the derived FTS row was purged too)',
    naru.search({ query: 'Postgres', scope: { type: 'project', key: 'acme' } }).length === 0,
  )
  check('get() on the forgotten fact returns undefined', naru.get(f3.id) === undefined)

  // 9. REINDEX ---------------------------------------------------------------
  section('Reindex — derived FTS rebuilt from canonical rows (plan §12.2)')
  await naru.reindex()
  check(
    'search still works after dropping & rebuilding the FTS index',
    naru
      .search({ query: 'tRPC', scope: { type: 'project', key: 'acme' } })
      .some((h) => h.factId === f2.id),
  )

  // 10. STATUS ---------------------------------------------------------------
  section('Status — store snapshot + capability seams for later milestones')
  const st = naru.status()
  console.log(`   db        : ${st.dbPath}`)
  console.log(
    `   counts    : facts=${st.counts.facts} entities=${st.counts.entities} episodes=${st.counts.episodes} scopes=${st.counts.scopes}`,
  )
  console.log(`   retention : ${st.retentionMode}`)
  console.log(`   features  : ${JSON.stringify(st.features)}`)
  note(
    'extractor (M2-A) + vector (M3) + server (M2-B) are wired; this walkthrough exercises the M1 core',
  )

  console.log(`\n${'═'.repeat(74)}`)
  console.log('  ✅ Walkthrough complete — every Milestone-1 invariant held.')
  console.log('═'.repeat(74))
} finally {
  naru.close()
  rmSync(dir, { recursive: true, force: true })
}

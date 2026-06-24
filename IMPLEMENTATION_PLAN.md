# Naru Memory Implementation Plan

> **Source of truth:** This markdown file is canonical. `IMPLEMENTATION_PLAN.html` is a styled render of this content and must be regenerated/synced whenever this file changes. Do not edit the HTML independently.

## 1. Objective

Build Naru Memory as a local-first, harness-agnostic memory system for AI agents and developer workflows.

Naru Memory should provide durable long-term memory, automatic fact extraction, hybrid retrieval, temporal graph reasoning, typed APIs, a CLI, a local tRPC server, and an OpenCode adapter. It should work without OpenCode, without MCP, and without any hosted dependency by default.

The core thesis:

> Naru Memory is a portable temporal fact graph with vector, text, entity, and graph retrieval indexes. Canonical memory records are local, inspectable, rebuildable, and separate from optimized indexes.

## 2. Locked Decisions

| Area | Decision |
| --- | --- |
| Repo path | `~/naru-memory` (local working copy) |
| Product boundary | Harness-agnostic memory core |
| First adapter | OpenCode native adapter |
| Server | Include local tRPC server immediately |
| Default storage | SQLite/libSQL-compatible local store |
| Default graph model | Relational temporal fact graph |
| Default AI mode | Local/offline by default |
| Hosted APIs | Optional later, never required by default |
| MCP | Optional later adapter, not core |
| Graph DB | Optional later adapter, not default |
| Licensing | Avoid BSL/SSPL dependencies in the default path |
| Updates | Non-destructive supersession, not destructive overwrite |
| Raw episode text | Redacted retention by default |
| Scope model | Typed scope graph with project/session/global behavior |
| Node version | Node 22 LTS (Node 24 only if this repo intentionally mirrors HammerTime) |
| Server access | Localhost bind + required auth token + `Origin`/`Host` validation from the first server release |
| Write coordination | Proxy writes to the local server when one is running; embedded mode otherwise, guarded by a discovery/lock file |
| Entity scoping | Per-scope entities by default; global/shared entities only by explicit promotion |
| Extraction timing | Reads (context injection) synchronous; writes (capture/extraction/embedding) asynchronous/background |
| Doc source of truth | `IMPLEMENTATION_PLAN.md` is canonical; the HTML is a render kept in sync |

## 3. Non-Goals

Naru Memory should not start as:

- An OpenCode-only plugin.
- A cloud-first API product.
- A wrapper around a single vector database.
- A graph database requirement.
- A raw chat transcript archive.
- An MCP-first product.
- A dependency on paid hosted services.
- A dependency on BSL/SSPL databases in the default path.

## 4. Research Summary

### 4.1 HammerTime Findings

HammerTime's topology system was the strongest architecture reference.

Key lessons:

- Canonical data should be portable and rebuildable.
- Query engines and indexes should be derived state, not the source of truth.
- Manifests provide idempotent commit boundaries.
- Raw extraction and synthesized overlays should be separate.
- Direct edges are useful for fast traversal.
- Reified metadata is useful for provenance, evidence, and scoring.
- Typed saved queries and typed API endpoints are better product boundaries than raw SPARQL/Cypher/SQL.
- Streaming and batching matter as graph size grows.
- Sidecars create real lifecycle complexity: locks, pid files, health checks, stale process cleanup, and store pools.

Implication for Naru:

- Store canonical memory in local tables and portable artifacts.
- Treat FTS/vector/entity/current-view indexes as rebuildable.
- Expose product APIs such as `context.build`, `memory.search`, and `fact.neighborhood` instead of raw query access.
- Avoid a required sidecar for the default embedded mode.

### 4.2 Graph DB Research

Reviewed backend options:

| Backend | Assessment |
| --- | --- |
| SQLite/libSQL | Best default fit for local-first, cloneable storage with vector support path |
| sqlite-vec | Interesting, but pre-v1 and not enough as the only bet |
| LanceDB | Strong embedded vector store, not a graph database |
| Qdrant | Strong vector DB, heavier than needed by default |
| Neo4j | Mature graph database, too heavy/server-oriented for default |
| SurrealDB | Attractive graph/doc/vector combination, BSL concern |
| FalkorDB | Interesting graph/vector/OpenCypher, SSPL concern |
| Kuzu | Most interesting embedded graph-native optional backend, but needs validation |

Decision:

- Default to SQLite/libSQL with graph modeled relationally.
- Add graph-native adapters only after real workload pressure justifies them.

### 4.3 Mem0 Findings

Mem0 is the closest serious product reference. It solves broadly the same category: long-term AI agent memory.

What Mem0 does well:

- Single-pass ADD-only extraction.
- Extracts memories instead of raw-saving conversations.
- Treats assistant-generated recommendations and actions as first-class memories.
- Multi-signal retrieval: semantic vector search, BM25 keyword search, entity matching, and optional reranking.
- Entity linking creates graph-like retrieval boosting.
- Strong prompt rules: preserve proper nouns, dates, numbers, exact details, and evidence grounding.
- Relative temporal references are grounded against an observation date.
- Scope model covers user, agent, app/project, and run/session.
- CLI has agent-friendly JSON mode.
- OpenCode plugin uses native tools/hooks instead of MCP.
- Compaction handling preserves memory context across summarization.
- Secret redaction exists before capture/injection.
- Self-hosted server includes auth, API keys, request logs, dashboard, and pgvector.

Where Naru should diverge:

- Mem0 OSS primarily stores memories in vector store payloads; Naru should store canonical memory in SQLite/libSQL tables.
- Mem0 graph memory is mostly schema-free entity-to-memory linking; Naru should model typed facts, evidence, temporal validity, and supersession.
- Mem0's platform/cloud path is central; Naru should be local-first by default.
- Mem0 update/delete semantics are more direct; Naru should use supersession plus explicit privacy deletion.

Implication for Naru:

- Borrow Mem0's extraction and retrieval quality.
- Borrow the adapter UX patterns.
- Do not copy the canonical data architecture.

## 5. Product Principles

- Local-first: usable without network access after local models are configured.
- Portable: memory can be exported, backed up, moved, and rebuilt.
- Inspectable: users can see what is remembered and why.
- Rebuildable: derived indexes can be dropped and regenerated.
- Scoped: memory retrieval must obey explicit scope boundaries.
- Evidence-backed: facts should point back to source episodes or hashes.
- Non-destructive by default: changed facts supersede older facts.
- Privacy-aware: secret redaction happens before storage, indexing, embeddings, or logs.
- Adapter-light: adapters call core APIs and do not own memory logic.
- Typed APIs: product API contracts over raw query languages.

## 6. Recommended Technology Stack

### 6.1 Language and Runtime

Use TypeScript ESM as the default implementation stack.

Recommended baseline:

- Node.js 24 if consistent with HammerTime conventions, otherwise Node.js 22 LTS.
- pnpm workspace.
- TypeScript strict mode.
- tRPC for local RPC surface.
- Zod or equivalent schemas for public contracts.
- SQLite/libSQL driver selected during implementation after evaluating vector extension support and local ergonomics.

Rationale:

- OpenCode adapter and CLI will be TypeScript-native.
- tRPC fits the preferred RPC style.
- Shared contracts can be used by CLI, server, adapter, and future UI.

### 6.2 Local AI Providers

Default posture: local/offline.

Provider interfaces should support:

- Local OpenAI-compatible HTTP endpoints.
- Ollama for LLM and embeddings.
- Manual `infer=false` add mode when no local LLM is available.
- FTS/entity search fallback when vector embeddings are unavailable.

The system should boot and remain useful without configured embeddings:

- `memory.add --infer=false` works.
- FTS5/BM25 search works.
- Entity extraction can use simple deterministic extraction or local NLP where available.
- Vector search activates only when embeddings and vector storage are configured.

## 7. Repository Layout

Initial layout:

```text
~/naru-memory
  apps/
    cli/
    server/
  packages/
    schema/
    store-sqlite/
    core/
    api/
    opencode-adapter/
  docs/
    IMPLEMENTATION_PLAN.md
```

Since this file currently lives at repo root before the repo is scaffolded, it can later move to `docs/IMPLEMENTATION_PLAN.md` if desired.

### 7.1 Package Responsibilities

| Package | Responsibility |
| --- | --- |
| `packages/schema` | Shared types, Zod schemas, API contracts, canonical model definitions |
| `packages/store-sqlite` | SQLite/libSQL migrations, persistence, transactions, query helpers |
| `packages/core` | Ingestion, extraction, linking, supersession, retrieval, context building, privacy |
| `packages/api` | tRPC routers and local API server integration contracts |
| `apps/cli` | User and agent CLI commands |
| `apps/server` | Local tRPC server, lifecycle, config, health/status |
| `packages/opencode-adapter` | Native OpenCode hooks/tools/commands using Naru APIs |

Later packages:

| Package | Responsibility |
| --- | --- |
| `packages/mcp` | Optional MCP server adapter |
| `packages/backend-kuzu` | Optional Kuzu graph backend adapter |
| `packages/backend-qdrant` | Optional Qdrant vector backend adapter |
| `apps/dashboard` | Optional memory explorer UI |

## 8. Core Data Model

Naru memory is centered around temporal, scoped, evidence-backed facts.

Canonical shape:

```text
Episode -> Evidence -> Fact
Fact -> Scope
Fact -> Entity
Fact -> Supersedes -> Fact
Entity -> Edge -> Entity
Fact -> Edge -> Entity
Fact -> Embedding index state
```

### 8.1 Main Concepts

| Concept | Description |
| --- | --- |
| Episode | Source event, message, summary, import, command result, or document |
| Entity | Person, repo, project, file, tool, concept, task, system, organization |
| Fact | Main memory unit with subject, predicate, object/value, confidence, temporal bounds |
| Edge | Typed relation between facts/entities for graph traversal |
| Scope | Boundary for reads/writes: user, workspace, project, branch, session, agent, global |
| Evidence | Link from fact to source episode span/snippet/hash |
| Supersession | Non-destructive changed-fact chain |
| Embedding | Derived vector index metadata for facts/entities |
| Profile/View | Synthesized current memory over active facts |

## 9. Scope Model

Use a typed scope graph rather than a single string.

### 9.1 Scope Types

| Scope | Purpose |
| --- | --- |
| `user` | Durable personal preferences and operator habits across projects |
| `workspace` | Local machine/workspace-level facts |
| `project` | Repo/project conventions, decisions, architecture, domain facts |
| `branch` | Branch-specific task state and implementation notes |
| `session` | Current agent run or conversation |
| `agent` | Agent-specific behavior, tools, constraints, or learned operations |
| `global` | Explicit all-project alias for the current user; resolved as a query-time scope-set expansion, not a stored scope node, and not a normal write target |

`global` is not a row in `scopes`. It is a query-time directive that expands the allowed read set to every project scope belonging to the current `user`. Writes never target `global`; a "global" write resolves to the `user` scope.

### 9.2 Default Write Scope

| Memory Type | Default Write Scope |
| --- | --- |
| User preference | `user` |
| Repo convention | `project` |
| Architecture decision | `project` |
| Current task progress | `session` |
| Branch-specific gotcha | `branch` |
| Agent capability/behavior | `agent` |
| Cross-project reusable workflow | `user` or explicit `global` |

### 9.3 Default Read Order

For normal developer work, `context.build` should read in this order:

```text
session -> agent -> branch -> project -> workspace -> user
```

`agent` scope is read alongside `session`/`branch` so agent-specific behavior and learned operations are available during a run; it sits just below `session` because it is run-adjacent but persists across sessions.

Ranking weight should prefer closer scopes:

```text
session > agent > branch > project > workspace > user > global
```

`global` only appears in ranking when a query explicitly opts into a global read (see below); its members are ranked by their underlying project/user scope.

Global reads should require explicit user or tool intent, such as:

- "Search all projects."
- `--scope global`.
- OpenCode tool call with `scope: "global"`.

Global writes should be rare and explicit.

### 9.4 Scope Safety Rule

Scope filtering must happen before ranking and before graph expansion.

Unsafe pattern:

```text
rank all memories -> filter scope
```

Safe pattern:

```text
resolve allowed scope set -> candidate retrieval inside allowed scopes -> graph expansion inside allowed scopes -> rank
```

## 10. Raw Episode Text Retention

Default recommendation: redacted episode retention.

### 10.1 Retention Modes

| Mode | Behavior | Default |
| --- | --- | --- |
| `redacted` | Store redacted episode text, evidence snippets, and source hashes | Yes |
| `minimal` | Store facts and evidence hashes only, no episode body | No |
| `encrypted` | Store original source encrypted locally | Later |
| `none` | Store extracted facts only, no episode/evidence text | Advanced privacy |

> **Retention determines what is rebuildable.** The plan's core principle — derived indexes are droppable and regenerable from canonical tables (§12.2) — only fully holds under `redacted` or `encrypted` retention. Under `minimal` or `none`, the source text is gone, so **facts cannot be re-extracted and embeddings cannot be regenerated** from canonical data; only FTS/entity indexes over already-stored facts can be rebuilt. Choosing `minimal`/`none` is an explicit trade of rebuildability/auditability for privacy. This must be surfaced in `naru status` and at config time.

### 10.2 Why Redacted Default

Redacted retention is the best default because it balances privacy and auditability.

Benefits:

- Enables users to inspect why a fact exists.
- Supports re-extraction when prompts or schema improve.
- Helps debug false memories.
- Preserves provenance without storing secrets.
- Avoids turning Naru into a raw chat-log archive.

Rules:

- Redact before persistence.
- Redact before embeddings.
- Redact before logs.
- Redact before adapter prompt injection.
- Never embed raw unredacted episode text.
- Store source hashes for dedupe and provenance.

## 11. SQLite Schema Plan

The exact SQL should be finalized during implementation, but the initial schema should cover the following tables.

### 11.1 `schema_migrations`

Tracks applied migrations.

Candidate columns:

- `version text primary key`
- `name text not null`
- `checksum text not null`
- `applied_at text not null`

### 11.2 `scopes`

Represents scope nodes.

Candidate columns:

- `id text primary key`
- `type text not null`
- `name text not null`
- `key text not null unique`
- `parent_scope_id text null references scopes(id)`
- `metadata_json text not null default '{}'`
- `created_at text not null`
- `updated_at text not null`

Indexes:

- unique `type + key`
- `parent_scope_id`

### 11.3 `episodes`

Represents captured source material.

Candidate columns:

- `id text primary key`
- `scope_id text not null references scopes(id)`
- `source_type text not null`
- `source_ref text null`
- `source_hash text not null`
- `hmac_hash text null`
- `retention_mode text not null`
- `redacted_text text null`
- `metadata_json text not null default '{}'`
- `observed_at text not null`
- `created_at text not null`

Indexes:

- `scope_id, observed_at`
- `source_hash`
- unique optional `scope_id + source_hash`

### 11.4 `entities`

Represents canonical named things.

Candidate columns:

- `id text primary key`
- `scope_id text null references scopes(id)`
- `type text not null`
- `canonical_name text not null`
- `normalized_key text not null`
- `aliases_json text not null default '[]'`
- `metadata_json text not null default '{}'`
- `created_at text not null`
- `updated_at text not null`

Indexes:

- `scope_id, normalized_key`
- `type, normalized_key`

Scoping policy:

- Entities are **per-scope by default**: `scope_id` is populated for normal entities, even though the column is nullable at the SQL level.
- A `null` `scope_id` denotes an explicitly **promoted global/shared entity** and is the exception, never the default. Promotion is a deliberate action, not a side effect of linking.
- Shared entities are the primary scope-leakage vector (see §18.3). The traversal rule there — *traverse through a shared entity but only collect facts within the allowed scope set* — is what makes shared entities safe.

### 11.5 `facts`

Represents the main memory units.

Candidate columns:

- `id text primary key`
- `scope_id text not null references scopes(id)`
- `subject_entity_id text null references entities(id)`
- `predicate text not null`
- `object_entity_id text null references entities(id)`
- `object_value text null`
- `statement text not null`
- `statement_hash text not null`
- `confidence real not null`
- `status text not null`
- `valid_from text null`
- `valid_to text null`
- `observed_at text not null`
- `created_at text not null`
- `updated_at text not null`
- `metadata_json text not null default '{}'`

Status values:

- `active`
- `superseded`
- `deleted`
- `rejected`
- `archived`

Indexes:

- `scope_id, status`
- `scope_id, predicate`
- `subject_entity_id`
- `object_entity_id`
- `statement_hash`
- `valid_from, valid_to`
- `observed_at`

#### Identifier and hash strategy

Dedup-on-import and cross-machine portability both depend on stable, well-specified IDs and hashes:

- **IDs:** use ULID (or UUIDv7) for all primary keys — sortable, collision-resistant, generable offline without coordination. Stable across export/import so references survive round-trips.
- **`statement_hash`:** a *portable content hash* over a canonicalized statement, computed identically on every machine and version. Canonicalization (specified once, versioned): Unicode NFC normalization, trim + collapse internal whitespace, casefold for matching, and a deterministic serialization of `(scope_key, subject, predicate, object/value)` with entity references resolved to normalized keys (not raw IDs) so the same fact hashes equally across stores. Bump a `hash_version` when the rule changes so old/new hashes don't silently collide or miss.
- **`source_hash`** (episodes, §11.3): hash of the redacted source plus source metadata, used for episode dedupe and provenance — same canonicalization discipline.

### 11.6 `evidence`

Links facts to episodes.

Candidate columns:

- `id text primary key`
- `fact_id text not null references facts(id)`
- `episode_id text not null references episodes(id)`
- `span_start integer null`
- `span_end integer null`
- `redacted_quote text null`
- `quote_hash text null`
- `extractor_name text not null`
- `extractor_version text not null`
- `created_at text not null`

Indexes:

- `fact_id`
- `episode_id`
- `quote_hash`

### 11.7 `edges`

Typed graph edges for traversal.

Candidate columns:

- `id text primary key`
- `scope_id text not null references scopes(id)`
- `source_type text not null`
- `source_id text not null`
- `predicate text not null`
- `target_type text not null`
- `target_id text not null`
- `confidence real null`
- `metadata_json text not null default '{}'`
- `created_at text not null`

Indexes:

- `scope_id, source_type, source_id`
- `scope_id, target_type, target_id`
- `scope_id, predicate`

### 11.8 `supersessions`

Non-destructive fact replacement.

Candidate columns:

- `id text primary key`
- `old_fact_id text not null references facts(id)`
- `new_fact_id text not null references facts(id)`
- `reason text null`
- `confidence real null`
- `created_at text not null`

Indexes:

- `old_fact_id`
- `new_fact_id`
- unique `old_fact_id + new_fact_id`

### 11.9 `embeddings`

Tracks embedding state. Actual vector storage may be in SQLite/libSQL vector columns, side tables, or derived index tables depending on driver capability.

Candidate columns:

- `id text primary key`
- `target_type text not null`
- `target_id text not null`
- `provider text not null`
- `model text not null`
- `dimension integer not null`
- `source_hash text not null`
- `status text not null`
- `vector_ref text null`
- `created_at text not null`
- `updated_at text not null`
- `error text null`

Indexes:

- `target_type, target_id`
- `provider, model, dimension`
- `status`

### 11.10 `index_state`

Tracks derived index freshness.

Candidate columns:

- `index_name text primary key`
- `index_version text not null`
- `source_watermark text null`
- `source_hash text null`
- `status text not null`
- `last_rebuilt_at text null`
- `error text null`
- `metadata_json text not null default '{}'`

### 11.11 FTS Tables

Use FTS5 for BM25-style text retrieval.

Initial candidates:

- `facts_fts(fact_id, statement, predicate, entity_text, scope_key)`
- `entities_fts(entity_id, canonical_name, aliases)`

These are derived and rebuildable.

## 12. Storage and Indexing Strategy

### 12.1 Canonical Store

The canonical store includes:

- `scopes`
- `episodes`
- `entities`
- `facts`
- `edges`
- `evidence`
- `supersessions`

These tables are authoritative and should be backed up/exported.

### 12.2 Derived Indexes

Derived indexes include:

- FTS5/BM25 index.
- Entity alias lookup index.
- Current-view active fact index.
- Graph-neighborhood helper indexes.
- Vector index when supported.
- Optional context cache later.

Derived indexes must be rebuildable from canonical tables, with two explicit caveats:

- **Facts** are only rebuildable from source when retention is `redacted`/`encrypted` (see §10.1). Under `minimal`/`none`, facts are themselves canonical (no source to re-extract from).
- **Vector indexes** are rebuildable only when (a) the source/fact text is retained and (b) the embedding provider/model is available. Re-embedding has real time/compute cost and is not free like rebuilding FTS. Treat vector rebuilds as a deliberate operation, not a routine drop-and-recreate.

### 12.3 SQLite Operational Settings

Recommended settings:

- WAL mode.
- Busy timeout.
- Foreign keys enabled.
- Transactional writes.
- Restrictive file permissions for local memory DB.

#### Write coordination (not optional)

Naru has three write entry points — CLI embedded mode, the tRPC server, and the OpenCode adapter — so concurrent writers against one SQLite file are a near-certainty, not an edge case. Decide the rule up front rather than "if it becomes an issue":

- **Single logical writer.** When a local server is running, all writers (CLI, adapter) **proxy writes to the server**, which owns a serialized ingestion queue. The server is discovered via a `server.json` file at a known config path (host, port, token, pid).
- **Embedded fallback.** When no live server is found, the CLI/adapter writes in embedded mode, guarded by a file lock so two embedded processes do not contend.
- WAL allows concurrent readers throughout; the coordination above is specifically for writes.
- This rule, the discovery file, and the auth token in §15.3 are the same mechanism viewed from storage vs. transport.

## 13. Ingestion Pipeline

The default ingestion pipeline should be ADD-only at the storage boundary.

```text
capture episode
  -> redact text
  -> compute source hash
  -> store episode
  -> extract candidate facts/entities
  -> normalize/link entities
  -> retrieve related existing facts
  -> dedupe exact/near duplicates
  -> detect changed facts
  -> write new facts/evidence/edges
  -> create supersession links when needed
  -> enqueue index updates
```

### 13.1 Episode Capture

Inputs:

- Source text or structured messages.
- Source type: `chat`, `tool`, `summary`, `import`, `manual`, `document`, `system`.
- Scope.
- Observation timestamp.
- Metadata.

Rules:

- Redact first.
- Validate scope.
- Store source hash.
- Deduplicate identical episodes per scope where appropriate.

### 13.2 Extraction

> **Latency budget: reads sync, writes async.** Extraction is an LLM call and must never sit on a latency-sensitive path. Memory **reads** (search, `context.build`, prompt injection) are synchronous and must stay fast. Memory **writes** (episode capture → extraction → linking → embedding → indexing) run **asynchronously in the background** off the agent's critical path. Capture acknowledges quickly after the episode is durably stored and redacted; extraction/embedding complete afterward and the new facts become retrievable once indexed. This is essential for the OpenCode adapter, where a per-message hook (§17.4) cannot block the agent loop on a local model.

Extraction should use a local LLM provider when configured.

The extractor should output typed JSON:

```json
{
  "facts": [
    {
      "subject": "User",
      "predicate": "prefers",
      "object": "dark mode",
      "statement": "User prefers dark mode for developer tools.",
      "entities": ["User", "dark mode"],
      "confidence": 0.86,
      "valid_from": null,
      "valid_to": null,
      "evidence": {
        "quote": "I prefer dark mode",
        "span_start": 0,
        "span_end": 18
      },
      "linked_fact_ids": []
    }
  ]
}
```

Prompt principles borrowed from Mem0:

- Extract all memorable information, not raw conversation.
- Preserve proper nouns, titles, exact dates, numbers, and specific details.
- Ground relative dates against observation date.
- Extract content from shared documents, not the meta-action of sharing.
- Distinguish user-stated facts from assistant-generated recommendations.
- Skip greetings, filler, and generic acknowledgments.
- Prefer rich, self-contained memories over overly atomic fragments.
- Avoid fabrication.
- Include evidence references where possible.

### 13.3 Local/Offline Fallback

When no extractor is configured:

- `memory.add --infer=false` stores the supplied text as a fact-like manual memory.
- Deterministic entity extraction may still run.
- FTS search remains available.
- System should report `extractor: unavailable` in status, not fail startup.

### 13.4 Entity Linking

Initial linking methods:

- Normalize names: lowercase, trim, collapse whitespace, strip punctuation where safe.
- Match aliases within scope.
- Match exact normalized key.
- Optional embedding similarity for entity names when embeddings are configured.

Entity linking should be scope-aware.

### 13.5 Deduplication

Dedup signals:

- Stable `statement_hash` within scope.
- Same subject/predicate/object.
- High similarity to existing active fact.
- Same evidence hash.
- Extractor-provided `linked_fact_ids`.

Actions:

- Exact duplicate: attach evidence to existing fact or ignore based on policy.
- Near duplicate with richer context: add new fact and optionally supersede old weaker fact.
- Conflict/change: add new fact and create supersession.

#### Capability tiers (be explicit about what degrades)

Distinguishing a *near-duplicate* from a *changed/conflicting* fact is an AI-hard judgment, so dedup/supersession capability is tiered by what's configured — and the milestones reflect this:

| Tier | Available | Dedup capability | Auto-supersession |
| --- | --- | --- | --- |
| No LLM, no embeddings (M1) | exact hash only | exact `statement_hash` within scope | none — use manual `naru supersede` |
| Embeddings, no LLM (M3) | + semantic similarity | exact + near-duplicate by vector similarity | heuristic only; conflicts still need confirmation |
| LLM configured (M2+) | + semantic judgment | full | LLM-judged change/conflict detection |

`naru supersede` / `fact.supersede` is the always-available manual fallback in every tier. Automatic supersession never silently fires below the LLM tier.

### 13.6 Supersession

Changed facts should not overwrite older facts.

Example:

```text
Old: User uses Jest for testing.
New: User switched from Jest to Vitest for this project.
```

Result:

- Insert new fact.
- Mark old fact as `superseded`.
- Insert `supersessions(old_fact_id, new_fact_id, reason)`.
- Current view returns the new fact.
- History view can still show both.

## 14. Retrieval and Context Building

Retrieval should be hybrid from the start, even if vector retrieval is optional at first.

```text
query
  -> resolve allowed scopes
  -> extract query entities
  -> FTS/BM25 candidates
  -> entity candidates
  -> vector candidates if available
  -> graph-neighborhood expansion
  -> current-view filtering
  -> temporal ranking
  -> hybrid scoring
  -> token-budget context packing
```

### 14.1 Candidate Sources

| Source | Purpose |
| --- | --- |
| FTS/BM25 | Exact terms, filenames, proper nouns, commands, errors |
| Entity match | Pull memories connected to query entities |
| Vector KNN | Semantic similarity |
| Graph neighborhood | Related facts around matched entities/facts |
| Recency/current view | Prefer currently active facts when relevant |

### 14.2 Ranking Signals

Suggested signals:

- Scope priority.
- Semantic vector score.
- BM25 score.
- Entity match strength.
- Graph proximity.
- Fact confidence.
- Evidence quality.
- Temporal validity.
- Recency.
- Supersession/current status.
- User-pinned or protected facts later.

#### Combination methodology

The signals above are combined, not used in isolation. Start simple and make it tunable rather than hardcoded:

- Normalize each signal to a comparable range before combining (e.g., min-max or z-score per candidate set; BM25 and cosine are not on the same scale).
- Combine as a **weighted linear score** with named, config-exposed weights as the v1 baseline — transparent and debuggable.
- Apply scope priority and current-view/temporal validity as **gates/multipliers**, not just additive terms, so an out-of-scope or superseded fact can't be ranked in by a strong vector score.
- Emit the per-signal contributions in the `reason` array (§14.4) so ranking is inspectable.
- **Weights are tuned against the retrieval eval set (§21.7), not guessed.** Treat the default weights as a checked-in artifact produced by that eval, revisited when signals change.

### 14.3 Current View

Current view excludes:

- `deleted` facts.
- `rejected` facts.
- superseded facts when the replacement is active and in an allowed scope.

It may include superseded facts only when:

- The query asks for history.
- `asOf` is before the supersession.
- The API option explicitly requests history.

### 14.4 Context Output

`context.build` should return structured context, not just a string.

Example response shape:

```json
{
  "items": [
    {
      "fact_id": "fact_...",
      "statement": "User prefers dark mode for developer tools.",
      "scope": "user",
      "score": 0.91,
      "evidence_refs": ["ev_..."],
      "temporal": {"valid_from": null, "valid_to": null},
      "reason": ["entity", "bm25", "scope:user"]
    }
  ],
  "prompt_block": "...",
  "token_estimate": 412
}
```

Adapters can inject `prompt_block`, while tools and UIs can inspect `items`.

## 15. tRPC API Surface

The local server should expose typed product APIs immediately.

### 15.1 Routers

Initial routers:

- `episode`
- `memory`
- `fact`
- `entity`
- `context`
- `scope`
- `index`
- `system`

### 15.2 Procedures

| Procedure | Purpose |
| --- | --- |
| `episode.capture` | Capture source material and optionally extract memories |
| `memory.add` | Add manual or inferred memory |
| `memory.search` | Hybrid memory search |
| `memory.list` | List memories by filters/scope |
| `memory.forget` | Explicit privacy deletion |
| `memory.history` | Show fact history/supersession chain |
| `fact.get` | Retrieve one fact with evidence |
| `fact.neighborhood` | Traverse nearby facts/entities |
| `fact.supersede` | Explicitly supersede one fact with another |
| `entity.list` | List entities in scope |
| `entity.get` | Retrieve entity and linked facts |
| `context.build` | Build prompt-ready memory context |
| `profile.get` | Current synthesized profile/view |
| `profile.refresh` | Rebuild profile/view |
| `scope.list` | List known scopes |
| `scope.resolve` | Resolve current user/project/session/branch scope |
| `index.rebuild` | Rebuild derived indexes |
| `index.status` | Show index freshness |
| `system.status` | Show DB path, providers, enabled features |
| `system.health` | Basic health check |

### 15.3 Server Requirements

Local server should, **from its first release** (not deferred):

- Bind to loopback (`127.0.0.1`) only by default.
- **Require an auth token on every request.** The token is generated at first start and written to `server.json` (mode `0600`) at a known config path; clients read it from there. A localhost-bound server is otherwise reachable by any local process and, via DNS-rebinding/CSRF, by any web page the user visits.
- **Validate `Origin`/`Host` headers** and reject cross-origin/unexpected-host requests, to defend against DNS-rebinding and browser-driven access to `127.0.0.1`.
- Write `server.json` (host, port, token, pid) for discovery (see §12.3), with restrictive permissions.
- Avoid exposing non-loopback interfaces unless explicitly configured (and warn loudly if configured).
- Support graceful shutdown and remove its `server.json` on exit (with stale-file detection on start).
- Expose health and status (health may be unauthenticated; everything else requires the token).
- Use the same core services as the CLI.

## 16. CLI Design

The CLI should be first-class for humans and agents.

Initial commands:

| Command | Purpose |
| --- | --- |
| `naru init` | Initialize local DB/config |
| `naru serve` | Start local tRPC server |
| `naru status` | Show DB/index/provider/server status |
| `naru add` | Add memory from text/stdin/file |
| `naru capture` | Capture episode with extraction |
| `naru search` | Search memories |
| `naru context` | Build context block for a query/task |
| `naru list` | List facts/memories |
| `naru get` | Get fact/entity/episode details |
| `naru forget` | Delete facts/entities/episodes by selector |
| `naru supersede` | Manually supersede one fact with another |
| `naru reindex` | Rebuild derived indexes |
| `naru export` | Export portable memory bundle |
| `naru import` | Import portable memory bundle |
| `naru opencode install` | Install OpenCode adapter |
| `naru opencode uninstall` | Remove OpenCode adapter-owned config |

Agent output:

- `--json` should return stable JSON envelopes.
- No spinners/colors in JSON mode.
- Errors should be JSON in JSON mode.
- Include `duration_ms`, `scope`, `count`, and `data` where useful.

## 17. OpenCode Adapter Design

The OpenCode adapter is an integration layer, not the memory system.

### 17.1 Responsibilities

- Resolve user/project/branch/session scopes.
- Register native OpenCode tools.
- Search and inject relevant memory before prompts.
- Capture explicit remember requests.
- Capture periodic task learnings if configured.
- Preserve memory context during compaction.
- Search past error memories after tool failures.
- Redact secrets before sending data to Naru.

### 17.2 Non-Responsibilities

- No duplicate extraction logic.
- No direct DB writes.
- No independent memory schema.
- No MCP requirement.
- No cloud/API-key assumption.

### 17.3 Native Tools

Initial OpenCode tools:

- `add_memory`
- `search_memories`
- `get_memories`
- `get_memory`
- `forget_memory`
- `build_memory_context`
- `list_entities`
- `memory_status`

### 17.4 Hooks

OpenCode hook behavior inspired by Mem0:

| Hook | Behavior |
| --- | --- |
| `config` | Register tools and skills/commands |
| `chat.message` | Detect remember/resume prompts and search relevant memory |
| `experimental.chat.messages.transform` | Inject memory context into prompt |
| `tool.execute.after` | Detect errors and search prior fixes/gotchas |
| `experimental.session.compacting` | Store compaction state and inject prior context |
| `shell.env` | Export Naru scope/session env vars |

Hook latency rules (see §13.2):

- Read/inject hooks (`chat.message` search, `experimental.chat.messages.transform`, `tool.execute.after` lookup) run synchronously but must hit only fast retrieval paths (FTS/entity/vector KNN/current-view) — never extraction.
- Capture/extraction triggered by hooks is **fire-and-forget**: the episode is queued for background ingestion so the agent loop is never blocked on a local LLM call. Newly captured facts surface on subsequent reads once ingestion completes.

### 17.5 Scope Mapping

OpenCode adapter scope mapping:

- `user`: OS user or configured Naru user ID.
- `workspace`: local workspace root.
- `project`: git remote owner/repo when available, otherwise git root directory name.
- `branch`: current git branch.
- `session`: generated OpenCode session ID.
- `agent`: OpenCode agent/model identity if available.

### 17.6 Adapter Safety

- Install should support dry-run.
- Config changes should use ownership markers.
- Uninstall should remove only owned entries.
- Preserve user config.
- Use restrictive permissions for local settings.
- Do not enable MCP by default.

## 18. Privacy and Security

### 18.1 Redaction

> **Redaction is best-effort defense-in-depth, not a hard guarantee.** Pattern/regex redaction *will* miss secrets in custom or non-standard formats. The design must not treat "redacted" as proof that no secret is present, and downstream layers (embeddings, logs, prompt injection) must minimize blast radius accordingly — once a secret reaches a vector index it is effectively unrecoverable/un-redactable. Where feasible, prefer not capturing high-risk material at all over relying on redaction to scrub it.

Redact before:

- Episode storage.
- Fact extraction.
- Embedding generation.
- FTS indexing.
- Logs.
- OpenCode prompt injection.

Initial secret redaction patterns:

- API keys.
- GitHub tokens.
- OpenAI-style keys.
- AWS access keys.
- Slack tokens.
- Bearer tokens.
- Private key blocks.
- `.env` style secret assignments.
- Password-looking fields.
- High-entropy token detection as a catch-all for unknown secret formats (flag/redact long high-randomness strings), with a configurable allowlist to avoid scrubbing legitimate identifiers.
- A configurable custom denylist for org/project-specific secret shapes.

#### PII vs. secrets

Naru deliberately stores *personal facts* ("User prefers dark mode") — that is the product's payload and is kept local-only. This is distinct from *secrets* and *sensitive PII*, which must be scrubbed:

- **Always redact:** secrets/credentials (above) and sensitive PII that has no memory value — emails, phone numbers, full street addresses, government/ID numbers, payment card numbers.
- **Retain (by design):** non-sensitive personal preferences, conventions, and operator habits that are the point of the memory system.
- The privacy posture is **local-first containment**: personal facts never leave the machine by default, are inspectable (§5), and are removable via `memory.forget` (§18.2).
- PII redaction runs in the same pre-persistence pass as secret redaction, with the same best-effort caveat.

### 18.2 Forget/Delete

`memory.forget` must support privacy deletion.

Selectors:

- fact ID.
- entity ID.
- episode ID.
- scope.
- text query with confirmation.
- before/after date.

Deletion must purge or invalidate:

- canonical facts.
- evidence.
- episodes if selected.
- edges.
- embeddings.
- FTS rows.
- entity links if orphaned.
- index/cache references.

For privacy deletes, deletion can be destructive. Supersession is for normal memory evolution, not privacy deletion.

### 18.3 Scope Leakage Prevention

Potential issue:

- Graph expansion can accidentally cross scope boundaries through shared entities. Because entities can be promoted to global/shared (`scope_id IS NULL`, see §11.4), a fact in project A and a fact in project B can both link to the same entity node. Naive traversal from one fact to the shared entity to the other fact leaks project B's memory into project A.

Required rules:

- Graph traversal must check allowed scopes at every hop.
- **Traverse *through* a shared entity, but only *collect* facts whose `scope_id` is in the allowed scope set.** The shared entity node being in-scope (or global) never authorizes returning facts from foreign scopes attached to it.
- Entity *identity* may be shared; entity-attached *facts* are always re-filtered by scope before they enter candidate sets or ranking.
- Promotion of an entity to global does not promote its facts; facts retain their original scope.

## 19. Import and Export

Naru should support portable memory bundles.

Export should include:

- schema version.
- scopes.
- episodes according to retention mode.
- entities.
- facts.
- evidence.
- edges.
- supersessions.
- no derived indexes by default.

Import should:

- validate schema version.
- preserve IDs when safe.
- dedupe by source/fact hashes (using the portable `statement_hash`/`source_hash` normalization in §11.5).
- rebuild indexes after import.

Caveat: rebuilding the **vector index** on import requires the embedding provider/model used at export (or a chosen replacement) to be available on the importing machine, and incurs re-embedding cost. If unavailable, import still succeeds and FTS/entity retrieval works; vector search stays degraded until re-embedding runs. Bundles should record the embedding provider/model/dimension so the importer can warn on mismatch.

This follows HammerTime's canonical-artifact principle.

## 20. Implementation Milestones

### Milestone 0: Repository Scaffold

Goal: create the workspace skeleton and development baseline.

Deliverables:

- pnpm workspace.
- TypeScript config.
- lint/format baseline.
- package skeletons.
- basic test runner.
- local config file convention.
- this plan moved into `docs/IMPLEMENTATION_PLAN.md` if desired.

### Milestone 1: Canonical Store and CLI

Goal: local memory works without LLM/vector dependencies.

Deliverables:

- SQLite/libSQL migrations.
- Store service.
- Scope service.
- Episode capture with redaction.
- Manual memory add with `infer=false`.
- Facts/entities/evidence/edges/supersessions tables.
- FTS5/BM25 search.
- Entity text extraction and linking baseline.
- Current-view queries.
- CLI commands: `init`, `add`, `search`, `list`, `get`, `forget`, `status`, `reindex`.
- JSON output mode.

Verification:

- Unit tests for schema, redaction, scope filtering, current view.
- SQLite integration fixture.
- CLI smoke tests.

### Milestone 2: Local Extraction and tRPC Server

Goal: automatic memory extraction through local providers and local API server.

Deliverables:

- Extractor provider interface.
- Ollama/OpenAI-compatible local LLM adapter.
- Extraction prompt and typed parser.
- Extraction confidence/evidence handling.
- Dedupe and supersession service (exact-hash tier now; semantic tiers land in M3, see §13.5).
- Asynchronous/background ingestion queue with a single logical writer (§13.2, §12.3).
- Local tRPC server in `apps/server` with **loopback bind, required auth token, `Origin`/`Host` validation, and a `server.json` discovery file** from day one (§15.3).
- Write coordination: CLI/adapter proxy to the server when running, file-locked embedded fallback otherwise (§12.3).
- tRPC routers for episode, memory, fact, entity, context, scope, index, system.
- CLI can use either direct embedded mode or local server mode.

Verification:

- Golden extraction fixtures.
- tRPC procedure tests.
- Local server smoke test, including auth-token enforcement and `Origin`/`Host` rejection.
- Optional: thin OpenCode adapter spike against this API to validate the contract shape before M4 hardening.

### Milestone 3: Vector and Hybrid Retrieval

Goal: production-quality retrieval.

Deliverables:

- Embedder provider interface.
- Local embedding provider adapter.
- SQLite/libSQL vector capability detection.
- Embedding/index state tracking.
- Hybrid ranker combining BM25, entity, vector, graph, temporal, scope, confidence, recency, with normalized signals and config-exposed weights (§14.2).
- Semantic dedup tier (near-duplicate detection) once embeddings exist (§13.5).
- `context.build` token-budget packing.
- Labeled quality eval set (retrieval recall@k/precision@k, scope-correctness, extraction precision) used to **tune ranking weights** (§21.7).
- Benchmarks for 1k and 10k facts.

Verification:

- Retrieval golden tests.
- Quality eval gates (recall, scope-correctness, extraction precision) wired into CI (§21.7).
- Rebuild tests proving indexes regenerate from canonical data (and that minimal/none retention correctly cannot re-extract — §10.1).
- Benchmark report.

### Milestone 4: OpenCode Adapter

Goal: first-class OpenCode integration.

Deliverables:

- Native OpenCode plugin/adapter package.
- Tools for add/search/get/forget/context/status.
- Hook-based memory search and injection.
- Compaction preservation.
- Error lookup.
- Scope resolution from git/user/session.
- Installer/uninstaller with dry-run and ownership markers.

Verification:

- Temp OpenCode config smoke test.
- Install/uninstall idempotency test.
- Prompt injection test with redaction.

### Milestone 5: Hardening and Portability

Goal: safe daily use.

Deliverables:

- Import/export bundles.
- Backup guidance.
- More robust redaction.
- Config migration.
- DB integrity checks.
- Index repair.
- Observability without leaking memory contents.

### Later Milestones

Potential later work:

- MCP adapter.
- Local dashboard/memory explorer.
- Optional hosted/self-host multi-user server.
- libSQL sync.
- Kuzu graph backend adapter.
- Qdrant/LanceDB vector backend adapters.
- Encrypted raw episode mode.
- Advanced memory consolidation/profile synthesis.

## 21. Verification Strategy

### 21.1 Unit Tests

Cover:

- Stable ID/hash generation.
- Redaction.
- Scope resolution.
- Scope filtering.
- Temporal validity.
- Supersession/current view.
- Entity normalization.
- JSON extraction parser.
- Ranking score combination.

### 21.2 Integration Tests

Use a golden SQLite fixture with:

- multiple scopes.
- 2 episodes.
- 3 entities.
- 4 facts.
- 1 changed/superseded fact.
- 1 secret-like string.
- branch/session/project/user scope overlap.

Validate:

- indexes rebuild from canonical tables.
- search returns scoped results only.
- current view hides superseded facts.
- forget purges canonical and derived state.

### 21.3 CLI Smoke Tests

Commands:

- `naru init --json`
- `naru add --infer=false --json`
- `naru search --json`
- `naru context --json`
- `naru status --json`
- `naru reindex --json`
- `naru forget --json`

### 21.4 Server Smoke Tests

Validate:

- server starts on localhost.
- health route works.
- tRPC client can call `system.status`.
- `memory.add` and `memory.search` work through server.
- server does not bind publicly by default.

### 21.5 OpenCode Adapter Smoke Tests

Use temp config/project.

Validate:

- install preserves existing config.
- no MCP is enabled by default.
- tools register.
- memory context is injected once.
- redaction works.
- uninstall removes only owned config.

### 21.6 Benchmarks

Benchmark sizes:

- tiny fixture.
- 1k facts.
- 10k facts.

Metrics:

- ingest latency.
- extraction latency when local model is configured.
- search p50/p95.
- context build p50/p95.
- reindex time.
- DB size.
- memory usage.

### 21.7 Quality Evaluation (relevance, not just latency)

Benchmarks (§21.6) measure speed and size; they say nothing about whether retrieval returns the *right* memories or extraction produces *correct* facts — which is the actual product value. A small, version-controlled labeled eval set is required:

- **Retrieval eval:** a labeled set of `(query, allowed-scope, expected fact IDs)` cases. Metrics: **recall@k** and **precision@k**, **scope-correctness rate** (zero out-of-scope leaks is a hard pass/fail, per §18.3), and ranking quality (e.g., MRR/nDCG). This eval is the ground truth used to tune the ranking weights in §14.2.
- **Extraction eval:** golden `(episode → expected facts/entities)` fixtures scored for precision/recall against the gold set, plus proper-noun/date/number preservation checks (the Mem0-derived prompt rules in §13.2).
- **Supersession eval:** changed-fact fixtures verifying the right old fact is superseded and the current view returns the new one (no false supersessions).
- Run these in CI as quality gates; a build that regresses recall, leaks scope, or drops extraction precision fails. Track scores over time alongside the benchmark report.

## 22. Risk Register

| Risk | Mitigation |
| --- | --- |
| Scope leakage | Scope filter before ranking and at every graph hop; traverse-through-shared-entity-but-collect-in-scope rule (§18.3); zero-leak hard gate in retrieval eval (§21.7) |
| Secret persistence | Redact before storage, embeddings, logs, and prompt injection; treat redaction as best-effort + entropy catch-all (§18.1) |
| Redaction false confidence | Frame redaction as defense-in-depth, add high-entropy detection + denylist, minimize blast radius into embeddings (§18.1) |
| PII handling | Distinct PII redaction pass (emails/phones/IDs/addresses); personal *facts* retained local-only by design (§18.1) |
| False memories | Require evidence, confidence, inspect and forget flows |
| Poor retrieval/extraction quality | Labeled quality eval set with recall@k, scope-correctness, extraction precision as CI gates (§21.7) |
| Index staleness | Track source hashes and rebuild state in `index_state` |
| Non-rebuildable under minimal/none retention | Make retention→rebuildability dependency explicit; surface in `naru status` and at config time (§10.1, §12.2) |
| SQLite write contention | WAL + busy timeout + transactions; **single logical writer via server-proxy when running, file-locked embedded fallback otherwise** (§12.3) — not deferred |
| Local server exposure (local process / DNS-rebind / CSRF) | Loopback bind + required auth token + `Origin`/`Host` validation from first release (§15.3) |
| Vector support differences | Feature-detect and degrade to FTS/entity search |
| Extraction latency on agent hot path | Reads sync, writes async/background; hooks fire-and-forget capture (§13.2, §17.4) |
| Local model unavailable | Manual add and deterministic retrieval still work |
| OpenCode config corruption | Dry-run, backups, ownership markers, uninstall |
| Privacy delete gaps | Tests for canonical and derived purge paths |
| Over-complex first release | Milestone 1 avoids vector/server complexity except planned server baseline in Milestone 2 |
| Late integration feedback | Optional thin adapter spike against the M2 API before hardening (§20) |
| Doc drift (MD vs HTML) | Markdown canonical; HTML regenerated/synced, never edited independently (§7) |
| Licensing drift | Default dependencies must be permissive; verify the specific SQLite/libSQL driver license at selection |

## 23. Configuration Plan

Initial local config location candidates:

- `~/.config/naru-memory/config.jsonc`
- `~/.local/share/naru-memory/naru.db`
- project override: `.naru-memory.jsonc`

Recommended config fields:

```jsonc
{
  "storage": {
    "provider": "sqlite",
    "path": "~/.local/share/naru-memory/naru.db"
  },
  "retention": {
    "mode": "redacted"
  },
  "server": {
    "host": "127.0.0.1",
    "port": 0
  },
  "llm": {
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "model": null
  },
  "embeddings": {
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "model": null
  },
  "privacy": {
    "redaction": true
  }
}
```

Implementation should avoid requiring model names until the user configures them.

## 24. Initial Implementation Checklist

After this plan file, the next implementation steps are:

1. Scaffold pnpm TypeScript workspace.
2. Add package skeletons for `schema`, `store-sqlite`, `core`, `api`, `cli`, `server`, and `opencode-adapter`.
3. Add initial schema contracts.
4. Add SQLite migration runner.
5. Add first migration for canonical tables.
6. Implement the ULID/`statement_hash` canonicalization utility (§11.5) so dedup/portability are stable from the first write.
7. Implement redaction utility (secret patterns + entropy catch-all + PII pass, best-effort; §18.1).
8. Implement `ScopeService` (including the `global` query-time expansion and per-scope entity policy; §9, §11.4).
9. Implement `EpisodeService`.
10. Implement manual `memory.add --infer=false`.
11. Implement FTS search.
12. Add `naru status` (surfacing retention mode / rebuildability) and `naru search` CLI JSON mode.
13. Add local tRPC server skeleton **with loopback bind, auth token, `Origin`/`Host` checks, and `server.json` discovery** (§15.3).
14. Add write coordination: server-proxy when running, file-locked embedded fallback (§12.3).

## 25. Remaining Open Questions

Resolved in this plan:

- Repo path: `~/naru-memory`.
- Local tRPC server: included immediately.
- Default AI mode: local/offline.
- Raw episode text: redacted retention by default.
- Scope hierarchy: user/workspace/project/branch/session/agent/global.
- Node version: **Node 22 LTS** (Node 24 only if intentionally mirroring HammerTime) — see §2.
- Server lifecycle/port: **random port + `server.json` discovery file** (host/port/token/pid); started manually via `naru serve` first, adapter auto-start only after lifecycle is proven — see §12.3, §15.3.
- Server access control: **loopback + required auth token + `Origin`/`Host` validation from first release** — see §15.3.
- Write coordination: **server-proxy when running, file-locked embedded fallback otherwise** — see §12.3.
- Project config: **secrets/DB paths user-local; non-secret scope labels and adapter behavior may be committed** — see §26.
- Entity scoping: **per-scope by default, global only by explicit promotion** — see §11.4, §18.3.
- Ranking-weight tuning: **driven by the quality eval set**, not hand-guessed — see §14.2, §21.7.

Still open for implementation:

- Exact SQLite/libSQL driver and vector extension path (feature-detected; must not block M1/M2 — see §26).
- Default local embedding model recommendation.
- Encrypted retention mode details (later milestone).

## 26. Recommended Answers to Remaining Questions

Initial recommendations:

- Use Node 22 LTS unless this repo intentionally mirrors HammerTime's Node 24 baseline.
- Start with SQLite FTS and entity retrieval before vector dependency hardening.
- Add vector support behind a feature-detected provider boundary.
- Use manual `naru serve` first; add adapter auto-start only after lifecycle is proven.
- Keep user secrets and DB paths user-local, not repo-committed.
- Allow project config for non-secret scope labels and adapter behavior only.

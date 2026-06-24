# Naru Memory

Local-first, harness-agnostic **memory for AI agents and developer workflows**. Durable, scoped, evidence-backed facts with hybrid retrieval — no hosted dependency by default.

> A portable temporal fact graph with vector, text, entity, and graph retrieval indexes. Canonical memory records are local, inspectable, rebuildable, and separate from optimized indexes.

## Install

```bash
npm install -g naru-memory     # or: pnpm add -g naru-memory
# or run without installing:
npx naru-memory --help
```

The package is `naru-memory`; it installs a `naru` command. Requires Node.js >= 22. The only native dependency is `better-sqlite3` (ships prebuilt binaries).

## Quickstart

```bash
naru init                                   # create the local DB + default scopes
naru add "User prefers pnpm workspaces" --scope project:my-app
naru search "pnpm" --scope project:my-app
naru status
```

With a local LLM (any OpenAI-compatible endpoint, e.g. Ollama) you can capture memories automatically:

```bash
naru capture "We migrated from Jest to Vitest" --scope project:my-app \
  --llm-provider openai-compat --llm-base-url http://127.0.0.1:11434/v1 --llm-model llama3.1
```

Everything works offline without an LLM (`naru add`, FTS/BM25 search); LLM extraction and vector search activate only when you configure a provider.

## What you get

- **Scoped memory** — `user` / `workspace` / `project` / `branch` / `session` / `agent`, with scope-safe retrieval.
- **Privacy-aware** — secrets and PII are redacted before anything is stored, indexed, embedded, or sent to a provider.
- **Hybrid retrieval** — FTS/BM25 + entity + vector + recency, with `naru context` for prompt-ready, token-budgeted blocks.
- **Non-destructive** — changed facts *supersede* old ones (history preserved); `naru forget` is the explicit destructive path.
- **Portable** — `naru export` / `naru import` portable bundles; `naru doctor` integrity check + repair; `naru backup` snapshots.
- **Local server** — `naru serve` exposes a secured (loopback + token + Origin-checked) tRPC API; the CLI auto-proxies to it.
- **OpenCode adapter** — `naru opencode install` registers native tools + hooks (no MCP required).

## Key commands

| Command | Purpose |
|---|---|
| `naru init` | Initialize the local DB + default scopes |
| `naru add` / `naru capture` | Add a memory manually / extract from text via an LLM |
| `naru search` / `naru context` | Hybrid search / prompt-ready context block |
| `naru list` / `naru get` | Inspect stored facts |
| `naru supersede` / `naru forget` | Update (non-destructive) / delete (destructive) |
| `naru export` / `naru import` | Portable memory bundles |
| `naru doctor [--repair]` / `naru backup` | Integrity check + repair / snapshot |
| `naru serve` | Start the secured local tRPC server |
| `naru opencode install` | Install the OpenCode adapter |

Add `--json` to any command for stable machine-readable output.

## Development

This is a pnpm + TypeScript monorepo (runs via `tsx`, no build needed for dev).

```bash
pnpm install
pnpm test          # full test suite
pnpm -r typecheck
pnpm lint
pnpm demo          # narrated walkthrough
pnpm build         # bundle the publishable `naru` package
```

## License

MIT — see [LICENSE](./LICENSE).

# 🧠 @narulabs/naru

**A local-first memory layer for AI agents and developer workflows.** Naru captures durable facts from your work and feeds the right ones back — to your agent or your own tools — on demand. Everything lives in a single SQLite file on your machine: **private, inspectable, and portable**, with no hosted service required. Installs a `naru` command.

```bash
npm install -g @narulabs/naru      # or: npx @narulabs/naru <command>

naru init
naru add "We use pnpm workspaces and Vitest" --scope project:my-app
naru search "test runner" --scope project:my-app
```

Requires **Node.js ≥ 22**. Add `--json` to any command for machine-readable output.

## Why

AI agents forget everything between sessions. Naru gives them long-term memory that **you own** — local, private, and queryable.

- 🏠 **Local-first & private** — one SQLite file, works offline; secrets/PII redacted before storage.
- 🎯 **Scoped** — `user` / `project` / `branch` / `session` / … with scope-safe retrieval (no cross-project leaks).
- 🔎 **Hybrid retrieval** — keywords + semantic vectors + entity + recency, with prompt-ready context blocks.
- 🕰️ **Non-destructive** — changed facts *supersede* old ones; history is preserved.
- 📦 **Portable** — export/import bundles, integrity check + repair, a secured local `naru serve` API, and an OpenCode plugin.

LLM extraction and vector search are optional — point Naru at any OpenAI-compatible endpoint (e.g. Ollama) to enable them; otherwise it runs fully offline.

## Common commands

| Command | Purpose |
|---|---|
| `naru init` | Initialize the local DB + default scopes |
| `naru add` · `naru capture` | Add a fact · extract facts from text (LLM) |
| `naru search` · `naru context` | Hybrid search · prompt-ready context block |
| `naru export` · `naru import` · `naru backup` | Portability |
| `naru serve` | Secured local tRPC server |
| `naru opencode install` | Install the OpenCode plugin |

**Status: alpha (`0.x`)** — APIs may change before `1.0`.

📖 Full docs, concepts, and architecture: **https://github.com/sean35mm/naru-memory**

MIT © Naru Memory authors

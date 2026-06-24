# naru-memory

Local-first, harness-agnostic **memory for AI agents and developer workflows** — durable, scoped, evidence-backed facts with hybrid retrieval and no hosted dependency by default. Installs a `naru` command.

```bash
npm install -g naru-memory     # or: npx naru-memory --help
naru init
naru add "User prefers pnpm workspaces" --scope project:my-app
naru search "pnpm" --scope project:my-app
```

Requires Node.js >= 22 (only native dep is `better-sqlite3`, which ships prebuilt binaries). Add `--json` to any command for machine-readable output.

Highlights: scoped + privacy-aware (secrets/PII redacted before storage), hybrid FTS/vector retrieval, non-destructive supersession, portable `export`/`import`/`backup`, a secured local `naru serve` tRPC API, and an OpenCode adapter (`naru opencode install`). LLM extraction and vectors are optional (any OpenAI-compatible endpoint).

See the [project README](https://github.com/sean35mm/naru-memory#readme) for full docs. License: MIT.

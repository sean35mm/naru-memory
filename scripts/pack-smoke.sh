#!/usr/bin/env bash
#
# Distribution smoke test: build + pack @narulabs/naru, install the tarball into
# a clean throwaway project WITHOUT optional/peer deps (the `npx` scenario), and
# run the published bin via its REAL path on plain Node. This catches the class
# of "builds fine but publishes broken" bugs:
#   - an optional peer (@opencode-ai/plugin) statically imported by the CLI,
#   - the server's run-if-invoked guard auto-starting on every command (hang),
#   - workspace:* leaks / missing deps.
# NOTE: it runs `node <pkg>/dist/index.js` directly (NOT ./node_modules/.bin/naru)
# because the bin symlink makes argv[1] != the real file and hides the
# auto-start guard bug, while npx/global-install use the real path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Portable bounded run: prefer GNU `timeout`, else fall back to run-without-bound.
if ! command -v timeout >/dev/null 2>&1; then
  echo "[pack-smoke] WARN: 'timeout' not found; hang detection disabled" >&2
  timeout() { shift; "$@"; }
fi

echo "[pack-smoke] building…"
pnpm build >/dev/null

echo "[pack-smoke] bundle hygiene checks…"
if grep -q '@opencode-ai/plugin' apps/cli/dist/index.js; then
  echo "[pack-smoke] FAILED — dist/index.js references @opencode-ai/plugin (optional peer would crash the CLI)" >&2
  exit 1
fi
if grep -q 'naru-server] listening' apps/cli/dist/index.js; then
  echo "[pack-smoke] FAILED — dist/index.js bundles the server auto-run entry (would hang every command)" >&2
  exit 1
fi
echo "[pack-smoke] hygiene OK (no optional-peer leak, no server auto-run in CLI bundle)"

TMPD="$(mktemp -d)"
PROJ="$(mktemp -d)"
trap 'rm -rf "$TMPD" "$PROJ"' EXIT

echo "[pack-smoke] packing…"
TGZ="$(pnpm --filter @narulabs/naru pack --pack-destination "$TMPD" | grep -oE '/[^ ]*\.tgz$' | tail -n 1)"
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "[pack-smoke] FAILED — could not locate packed tarball" >&2
  exit 1
fi
echo "[pack-smoke] tarball: $(basename "$TGZ")"

echo "[pack-smoke] installing into a clean project (no optional/peer deps = the npx scenario)…"
cd "$PROJ"
npm init -y >/dev/null 2>&1
npm install "$TGZ" --no-audit --no-fund --omit=optional --omit=peer >/dev/null
if [ -d node_modules/@opencode-ai/plugin ]; then
  echo "[pack-smoke] note: @opencode-ai/plugin got installed anyway; the npx path may differ" >&2
fi

PKG="$PROJ/node_modules/@narulabs/naru"
run() { timeout 25 node "$PKG/dist/index.js" "$@"; }

echo "[pack-smoke] naru --help must print AND exit (catches the auto-start hang)…"
if ! run --help >/dev/null 2>&1; then
  echo "[pack-smoke] FAILED — 'naru --help' did not exit cleanly (hang or crash)" >&2
  exit 1
fi

DB="$PROJ/mem.db"
run init --db "$DB" --json >/dev/null || { echo "[pack-smoke] FAILED — naru init" >&2; exit 1; }
run capture "packaging smoke: vitest and pnpm toolchain" --scope project:smoke --llm-provider mock --json >/dev/null \
  || { echo "[pack-smoke] FAILED — naru capture" >&2; exit 1; }
RESULT="$(run search "pnpm" --scope project:smoke --json)" \
  || { echo "[pack-smoke] FAILED — naru search" >&2; exit 1; }

echo "$RESULT" | node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const r = JSON.parse(s)
    if (!r.ok || !r.data || !Array.isArray(r.data.results) || r.data.results.length < 1) {
      console.error("[pack-smoke] FAILED — unexpected result:", s)
      process.exit(1)
    }
    console.log(`[pack-smoke] OK — installed naru returned ${r.data.results.length} result(s)`)
  })
'

#!/usr/bin/env bash
#
# Distribution smoke test: build + pack the `naru` package, install the tarball
# into a clean throwaway project, and run the published bin on plain Node
# (no tsx, no workspace) to prove the SHIPPED artifact actually works. This is
# what catches "builds fine but publishes broken" (missing dep, workspace:*
# leak, a bundled lib that breaks at runtime, etc.).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[pack-smoke] building…"
pnpm build >/dev/null

TMPD="$(mktemp -d)"
PROJ="$(mktemp -d)"
trap 'rm -rf "$TMPD" "$PROJ"' EXIT

echo "[pack-smoke] packing…"
# Take the exact tarball path pnpm reports (robust against multiple .tgz files).
TGZ="$(pnpm --filter @narulabs/naru pack --pack-destination "$TMPD" | grep -oE '/[^ ]*\.tgz$' | tail -n 1)"
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "[pack-smoke] FAILED — could not locate packed tarball" >&2
  exit 1
fi
echo "[pack-smoke] tarball: $(basename "$TGZ")"

echo "[pack-smoke] installing into a clean project…"
cd "$PROJ"
npm init -y >/dev/null 2>&1
npm install "$TGZ" --no-audit --no-fund >/dev/null

NB="./node_modules/.bin/naru"
DB="$PROJ/mem.db"

echo "[pack-smoke] running the installed bin on plain node…"
"$NB" init --db "$DB" --json >/dev/null
"$NB" capture "packaging smoke: vitest and pnpm toolchain" --scope project:smoke --llm-provider mock --json >/dev/null
RESULT="$("$NB" search "pnpm" --scope project:smoke --json)"

# Validate the result with Node (no python dependency in CI).
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

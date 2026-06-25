import { defineConfig } from 'tsup'

/**
 * Build the publishable `@narulabs/naru` package into two self-contained ESM
 * bundles, each with its own entry:
 *
 *  1. `dist/index.js` — the `naru` CLI bin (unchanged): a single bundle with a
 *     plain-Node shebang so the bin runs without tsx.
 *  2. `dist/opencode.js` — the OpenCode plugin (`@narulabs/naru/opencode`): the
 *     REAL `@opencode-ai/plugin` surface, imported by opencode (NOT executed as a
 *     bin) — so it gets NO shebang.
 *
 * Shared bundling rules:
 * - Bundles the workspace `@naru/*` packages into `dist/` so the published
 *   package carries no `workspace:*` references. For the opencode entry this
 *   bundles `@naru/opencode-adapter/plugin` (remote-only) + `@trpc/client`; the
 *   adapter's TYPE-ONLY `@naru/api` import is erased at build, so neither
 *   `@naru/core`, `@naru/store-sqlite`, nor the `@naru/server` barrel (all native
 *   `better-sqlite3`) is pulled into `dist/opencode.js`.
 * - Externalizes every third-party npm dep (declared in `dependencies`):
 *   `better-sqlite3` (native — must fetch a per-platform prebuild) and the
 *   pure-JS libs. `ulid` in particular MUST stay external: bundling it breaks its
 *   runtime secure-PRNG detection ("secure crypto unusable"). npm resolves these
 *   normally at install time.
 * - `@opencode-ai/plugin` is a PEER dep provided by the opencode host at runtime,
 *   so it is externalized too (never bundled).
 */

const external = [
  'better-sqlite3',
  'ulid',
  'zod',
  'commander',
  '@trpc/server',
  '@trpc/client',
  '@opencode-ai/plugin',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    noExternal: [/^@naru\//],
    external,
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
    dts: false,
    sourcemap: false,
    splitting: false,
    shims: false,
  },
  {
    entry: { opencode: 'src/opencode.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    noExternal: [/^@naru\//],
    external,
    clean: false,
    dts: false,
    sourcemap: false,
    splitting: false,
    shims: false,
  },
])

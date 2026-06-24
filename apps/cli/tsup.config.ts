import { defineConfig } from 'tsup'

/**
 * Build the publishable `naru` CLI into a single self-contained ESM bundle.
 *
 * - Bundles only the workspace `@naru/*` packages into `dist/` so the published
 *   package carries no `workspace:*` references.
 * - Externalizes every third-party npm dep (declared in `dependencies`):
 *   `better-sqlite3` (native — must fetch a per-platform prebuild) and the
 *   pure-JS libs. `ulid` in particular MUST stay external: bundling it breaks
 *   its runtime secure-PRNG detection ("secure crypto unusable"). npm resolves
 *   these normally at install time.
 * - Adds a plain-Node shebang so the `naru` bin runs without tsx.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: [/^@naru\//],
  external: ['better-sqlite3', 'ulid', 'zod', 'commander', '@trpc/server', '@trpc/client'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  shims: false,
})

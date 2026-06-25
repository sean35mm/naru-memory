import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@naru/schema': src('./packages/schema/src/index.ts'),
      '@naru/store-sqlite': src('./packages/store-sqlite/src/index.ts'),
      '@naru/core': src('./packages/core/src/index.ts'),
      '@naru/api': src('./packages/api/src/index.ts'),
      '@naru/opencode-adapter/installer': src('./packages/opencode-adapter/src/installer.ts'),
      '@naru/opencode-adapter/plugin': src('./packages/opencode-adapter/src/opencode-plugin.ts'),
      '@naru/opencode-adapter': src('./packages/opencode-adapter/src/index.ts'),
      '@naru/server': src('./apps/server/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
})

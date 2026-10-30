import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@cs-agent/core': root + 'packages/core/src/index.ts',
      '@cs-agent/config': root + 'packages/config/src/index.ts',
      '@cs-agent/hubspot': root + 'packages/hubspot/src/index.ts',
      '@cs-agent/setup': root + 'packages/setup/src/index.ts',
      '@cs-agent/bundle': root + 'packages/bundle/src/index.ts',
      '@cs-agent/signals': root + 'packages/signals/src/index.ts',
      '@cs-agent/scoring': root + 'packages/scoring/src/index.ts',
      '@cs-agent/procedures': root + 'packages/procedures/src/index.ts',
      '@cs-agent/llm': root + 'packages/llm/src/index.ts',
      '@cs-agent/agent': root + 'packages/agent/src/index.ts',
      '@cs-agent/ledger': root + 'packages/ledger/src/index.ts',
      '@cs-agent/policy': root + 'packages/policy/src/index.ts',
      '@cs-agent/commit': root + 'packages/commit/src/index.ts',
      '@cs-agent/approvals': root + 'packages/approvals/src/index.ts',
      '@cs-agent/workflows': root + 'packages/workflows/src/index.ts',
      '@cs-agent/seed': root + 'packages/seed/src/index.ts',
      '@cs-agent/evals': root + 'packages/evals/src/index.ts',
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    testTimeout: 20000,
  },
});

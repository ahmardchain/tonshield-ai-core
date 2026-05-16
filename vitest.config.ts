import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/wallet/budgetPolicy.ts',
        'src/risk/velocityGuard.ts',
        'src/risk/riskScore.ts',
        'src/risk/triggerEngine.ts',
        'src/ston/networkGuard.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});

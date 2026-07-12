import { defineConfig } from 'vitest/config';
import { agentAlias } from '../../vitest.alias.mjs';

export default defineConfig({
  resolve: { alias: agentAlias },
  test: { environment: 'node', testTimeout: 20_000, hookTimeout: 20_000 },
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lis/contracts': pkg('contracts'),
      '@lis/protocol-astm': pkg('protocol-astm'),
      '@lis/protocol-hl7v2': pkg('protocol-hl7v2'),
      '@lis/domain': pkg('domain'),
      '@lis/adapter-cobas-e411': pkg('adapter-cobas-e411'),
      '@lis/adapter-mindray-hl7': pkg('adapter-mindray-hl7'),
      '@lis/adapter-generic': pkg('adapter-generic'),
      '@lis/transport': pkg('transport'),
      '@lis/analyzer-runtime': pkg('analyzer-runtime'),
      '@lis/db': pkg('db'),
      '@lis/analyzer-worker': pkg('analyzer-worker'),
      '@lis/result-intake': pkg('result-intake'),
      '@lis/hmis': pkg('hmis'),
      '@lis/lab': pkg('lab'),
      '@lis/web': pkg('web'),
      '@lis/ops': pkg('ops'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});

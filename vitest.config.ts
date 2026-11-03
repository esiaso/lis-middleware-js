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
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});

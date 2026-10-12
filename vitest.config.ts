import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // JSX 自动运行时（否则 vitest 下 JSX 转成 React.createElement 而组件没 import React）
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'node',
    include: [
      'lib/**/*.test.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['./tests/setup-dom.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});

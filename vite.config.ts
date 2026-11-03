import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
  // Agent worktrees live under .claude/; keep the dev server out of them.
  server: {
    watch: { ignored: ['**/.claude/**'] },
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});

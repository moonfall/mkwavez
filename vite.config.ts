import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
  // Agent worktrees live under .claude/; keep the dev server out of them.
  server: {
    allowedHosts: ['fluffy2.10q.ca'],
    // No live reload: merges land in this checkout while a session is open, and
    // reloading would discard unsaved state. Reload the page manually to update.
    hmr: false,
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

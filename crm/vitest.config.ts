import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
  },
  // better-sqlite3 loads a native .node addon — mark it external so Vite
  // never bundles it and Node's require() can resolve relative paths normally.
  ssr: {
    external: ['better-sqlite3', 'sqlite-vec'],
    noExternal: [],
  },
});

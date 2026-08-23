import { defineConfig } from 'vitest/config';

/**
 * Configuration de test séparée de `vite.config.ts` : Vitest embarque sa propre
 * version de Vite, et mélanger les deux graphes de types casse `tsc --noEmit`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});

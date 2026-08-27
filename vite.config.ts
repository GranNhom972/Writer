import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** Serveur de partage — le port par défaut de `WRITER_BIND`. */
const SERVEUR_PAR_DEFAUT = 'http://127.0.0.1:8081';

export default defineConfig(({ mode }) => {
  // `loadEnv` plutôt que `process.env` : le projet n'a pas les types Node, et
  // cette fonction lit aussi les fichiers `.env`, que `process.env` ignore.
  const env = loadEnv(mode, '.', 'WRITER_');

  return {
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      // Le client parle à `/api/v1/...` en relatif : c'est ce qui fait que le
      // WebSocket et les images partagent l'origine de la page, donc que le
      // navigateur n'a ni CORS ni préflight à négocier.
      proxy: {
        '/api': {
          target: env['WRITER_SERVER'] || SERVEUR_PAR_DEFAUT,
          changeOrigin: false,
          // `ws: true` est indispensable : sans lui, la montée en WebSocket de
          // `/api/v1/sync/...` est traitée comme une requête HTTP ordinaire et
          // échoue avec un 400 que rien n'explique côté client.
          ws: true,
        },
      },
    },
  };
});

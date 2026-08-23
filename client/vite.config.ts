import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Le client parle au serveur Rust (Axum) via la même origine en développement :
      // pas de CORS, et l'en-tête Origin reste celui attendu par le serveur.
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false, ws: true },
    },
  },
});

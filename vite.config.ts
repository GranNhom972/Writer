import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** Sharing server: the default port of `WRITER_BIND`. */
const SERVEUR_PAR_DEFAUT = 'http://127.0.0.1:8081';

export default defineConfig(({ mode }) => {
  // `loadEnv` rather than `process.env`: the project does not have the Node types, and this function also reads the `.env` files, which `process.env` ignores.
  const env = loadEnv(mode, '.', 'WRITER_');

  /*
   * Hosts allowed to reach the development server.
   *
   * Vite refuses requests whose `Host` header it does not know: that is what protects the machine from *DNS rebinding*, where a public page makes its name resolve to `127.0.0.1` in order to talk to the local server from the
   * developer's browser. IP addresses and `localhost` pass automatically; a machine name does not.
   *
   * Hence this list, fed by `WRITER_ALLOWED_HOSTS` (comma-separated) rather than by `allowedHosts: true`, which would lift the check for everybody, including for a page that has no business being there.
   *
   *   WRITER_ALLOWED_HOSTS=dev.local npm run dev
   */
  const allowedHosts = (env['WRITER_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((hote) => hote.trim())
    .filter((hote) => hote.length > 0);

  return {
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      // The client talks to `/api/v1/...` with relative addresses: that is what makes the WebSocket and the images share the page's origin, so that the browser has neither CORS nor a preflight to negotiate.
      proxy: {
        '/api': {
          target: env['WRITER_SERVER'] || SERVEUR_PAR_DEFAUT,
          changeOrigin: false,
          // `ws: true` is indispensable: without it, upgrading `/api/v1/sync/...` to a WebSocket is treated as an ordinary HTTP request and fails with a 400 that nothing explains on the client side.
          ws: true,
        },
      },
    },
  };
});

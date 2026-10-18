import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Requests the SPA never answers: the API and the liveness probe belong to the server. */
const SERVER_PATHS = [/^\/v1\//, /^\/healthz$/];

export default defineConfig({
  plugins: [
    react(),
    // Slice 1a precaches the app shell only: no runtime caching of API responses, no manifest
    // (the offline trip bundle is its own story).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: SERVER_PATHS,
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { outDir: 'dist/app', emptyOutDir: true, sourcemap: true },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Served through Caddy at https://tribo.localhost in the dev stack.
    allowedHosts: ['tribo.localhost'],
    hmr: {
      clientPort: Number(process.env.TRIBO_WEB_HMR_PORT ?? 443),
      protocol: 'wss',
      host: 'tribo.localhost',
    },
    // Some Docker VMs drop host file events on bind mounts (deploy/dev/README.md).
    watch: process.env.TRIBO_WEB_POLL === '1' ? { usePolling: true, interval: 300 } : {},
  },
});

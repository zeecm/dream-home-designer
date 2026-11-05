import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' blob: data: https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const api = process.env.API_URL ?? 'http://localhost:8080';
// Same-origin in dev and preview, so no CORS. In production a Pages Function routes /api.
const proxy = { '/api': { target: api, rewrite: (p: string) => p.replace(/^\/api/, '') } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  // The production Content-Security-Policy (public/_headers), so the e2e suite runs under it.
  preview: { port: 4173, proxy, headers: { 'Content-Security-Policy': CSP } },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    // The app, and the welcome page that introduces it.
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('index.html', import.meta.url)),
        welcome: fileURLToPath(new URL('welcome/index.html', import.meta.url)),
      },
    },
  },
});

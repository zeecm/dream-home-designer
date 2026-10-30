import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:8080';
// Same-origin in dev and preview, so no CORS. In production a Pages Function routes /api.
const proxy = { '/api': { target: api, rewrite: (p: string) => p.replace(/^\/api/, '') } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
});

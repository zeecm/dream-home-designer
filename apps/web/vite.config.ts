import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev, so no CORS. In production Pages routes /api to the Go service.
    proxy: { '/api': { target: api, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
});

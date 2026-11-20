import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The built console is served by acm-core from the same origin as /api/v1.
// During development, `npm run dev` proxies the API to a running service.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8766' },
  },
});

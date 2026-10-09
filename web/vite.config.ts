import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const api = process.env.API_URL ?? 'http://127.0.0.1:4780';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@berrie/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: { '/api': api, '/ws': { target: api.replace('http', 'ws'), ws: true } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});

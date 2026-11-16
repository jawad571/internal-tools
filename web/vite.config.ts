import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const shared = decodeURIComponent(new URL('../src/shared', import.meta.url).pathname);
const backend = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': shared },
  },
  server: {
    port: 5173,
    // contracts.ts lives outside web/ and imports zod from the repo-root node_modules.
    fs: { allow: ['..'] },
    proxy: {
      '/api': backend,
      '/feed': backend,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});

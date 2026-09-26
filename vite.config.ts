import { defineConfig } from 'vite';

// Fully static build: `npm run build` emits ./dist which can be served from any static host.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});

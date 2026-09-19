import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './manifest.config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@storage': resolve(__dirname, 'src/storage'),
      '@search': resolve(__dirname, 'src/search'),
    },
  },
  plugins: [preact(), crx({ manifest })],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        palette: resolve(__dirname, 'src/ui/palette-page.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
  // Transformers.js references node-only modules behind runtime guards; keep it external-free for the browser build.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});

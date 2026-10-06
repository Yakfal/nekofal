// Vite config used ONLY to bundle the browser test harness
// (tests/harness/index.html -> tests/.harness-dist).
//
// The production vite.config.js targets Electron and emits to build/. The
// harness needs the same real component code but as a standalone page that
// plain Chromium can load, so it gets its own config and output directory.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const root = path.resolve(__dirname);

export default defineConfig({
  root,
  plugins: [react()],
  base: './',
  // Keep identifier names so stack traces in a failing run point at real
  // source symbols rather than minified ones.
  esbuild: { keepNames: true, minifyIdentifiers: false },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    target: 'chrome120',
    outDir: path.resolve(__dirname, '..', '.harness-dist'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: path.join(root, 'index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('hls.js')) return 'hls';
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5199,
    strictPort: true,
    fs: { strict: false },
  },
});
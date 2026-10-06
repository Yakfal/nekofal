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
resolve: {
    alias: {
      // The real dbAdapter drives the Electron DB/cloud bridge, which does not
      // exist in a plain Chromium harness page. An ES-module namespace object is
      // frozen, so it cannot be monkey-patched at runtime — alias it at build
      // time instead. This applies to the harness only.
      [path.resolve(__dirname, '..', '..', 'src', 'services', 'dbAdapter.js')]:
        path.resolve(__dirname, 'db-adapter-stub.js'),
    },
  },
  build: {
    target: 'chrome120',
    outDir: path.resolve(__dirname, '..', '.harness-dist'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        // Two harness pages: the VideoPlayer playback surface and the
        // Family-Mode (adult passcode) gate.
        main: path.join(root, 'index.html'),
        adult: path.join(root, 'adult.html'),
      },
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
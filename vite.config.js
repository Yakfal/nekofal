import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  esbuild: {
    keepNames: true,
    // NEVER let esbuild mangle identifiers: renamed bindings that get captured
    // in earlier closures/deps (e.g. useCallback chains) can collide and throw
    // "Cannot access 'X' before initialization" at runtime in the minified
    // bundle. Keeping real names makes a mangled-TDZ class impossible.
    minifyIdentifiers: false,
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: true,
      },
    },
  },
  build: {
    target: 'es2015',
    cssTarget: 'chrome61',
    minify: 'esbuild',
    outDir: 'build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        preload: path.resolve(__dirname, 'electron/preload.js')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          return chunkInfo.name === 'preload' ? 'preload.js' : 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        }
      }
    }
  },
  server: {
    port: 3000,
    strictPort: true
  }
})
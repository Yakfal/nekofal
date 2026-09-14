import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  esbuild: {
    keepNames: true,
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: true,
      },
    },
  },
  build: {
    target: 'es2020',
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
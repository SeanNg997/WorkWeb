import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: 'src/novel-project-editor.jsx',
      name: 'NovelProjectEditor',
      formats: ['iife'],
      fileName: () => 'novel-project-editor.js',
      cssFileName: 'novel-project-editor'
    },
    outDir: 'vendor',
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});

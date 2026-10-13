import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ root: 'desktop/renderer', base: './', plugins: [vue()],
  build: { outDir: '../../desktop-dist', emptyOutDir: true } });

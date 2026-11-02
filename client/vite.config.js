import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 配置文件位于 client/ 内，root 用绝对路径，避免从仓库根目录执行时的相对路径歧义。
const clientRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(clientRoot, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(clientRoot, '../dist/client'),
    emptyOutDir: true,
    sourcemap: false,
  },
});

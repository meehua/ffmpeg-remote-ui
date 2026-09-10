import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时前端由 Vite 提供，/api 需要转发到真实后端。
// 后端默认使用随机端口，把终端打印的地址填入 API_TARGET 即可。
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // 前端资源会被嵌进单一 Go 二进制，少发请求比分包更重要。
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});

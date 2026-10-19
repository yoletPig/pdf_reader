import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 端口/后端地址可由环境变量覆盖（由 start.sh 注入），手动 npm run dev 时使用默认值
const FRONTEND_PORT = Number(process.env.PDF_READER_FRONTEND_PORT) || 5173
const BACKEND_URL = process.env.PDF_READER_BACKEND_URL || 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: FRONTEND_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
})

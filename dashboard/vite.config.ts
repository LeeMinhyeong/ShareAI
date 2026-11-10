import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api/admin/routing-snapshot': {
        target: 'http://localhost:20100',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
      '/admin/accounts/siwc': {
        target: 'http://localhost:20100',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:20100',
        changeOrigin: true,
      },
    },
  },
})
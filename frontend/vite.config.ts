import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Shadow-KYC API server (src/api-server.ts) runs on port 8080 and holds
// the wallet + deployed-contract connection. In dev, the Vite dev server on
// port 5173 proxies /api requests to it so the frontend can use relative
// URLs. In production, the API server serves the built frontend directly.
const API_TARGET = process.env.API_URL ?? 'http://127.0.0.1:8080'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
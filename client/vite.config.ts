import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // Use relative paths for assets so Bun can resolve them during bundle
  root: 'client', // Explicitly tell Vite the root is the client folder
  build: {
    outDir: 'dist', // Output to client/dist
    emptyOutDir: true,
  }
})

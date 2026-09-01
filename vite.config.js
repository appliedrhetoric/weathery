import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Deployed to byterange.com/weather/, not the domain root, so built asset
  // URLs need the subdirectory prefix.
  base: '/weather/',
  plugins: [react()],
})

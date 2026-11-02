import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves the site from /Arcade-Game/; Render serves it from the root.
  base: process.env.PAGES_BASE || '/',
})

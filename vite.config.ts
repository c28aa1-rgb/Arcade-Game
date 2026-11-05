import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves the site from /Arcade-Game/; Render serves it from the root.
  base: process.env.PAGES_BASE || '/',
  build: {
    rollupOptions: {
      output: {
        // React rarely changes, so it gets its own file that browsers keep
        // cached across updates to the casino itself
        manualChunks: (id) => (/node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'react' : undefined),
      },
    },
  },
})

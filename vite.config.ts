import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the site under /novela-web/; Netlify uses "/".
// Set via GH_PAGES=1 in the Pages workflow.
const base = process.env.GH_PAGES ? '/novela-web/' : '/'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
})

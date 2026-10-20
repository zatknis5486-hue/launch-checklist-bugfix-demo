import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/ and https://vitest.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Keep module ids under the project root even when the project directory
    // is reached through a filesystem alias (a junction, or a virtualized
    // folder on Windows). Without this, Vite's realpath() can resolve files to
    // a path outside `server.fs.allow`, and the dev server / Vitest refuse to
    // load them. Harmless for a normal checkout: this repo has no symlinks.
    preserveSymlinks: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    passWithNoTests: true,
    css: false,
  },
})

import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve('src/main/index.js') },
      // chokidar must stay external (native fs internals are not bundle-friendly)
      lib: { entry: resolve('src/main/index.js'), formats: ['es'] },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: resolve('src/preload/index.js') },
      lib: { entry: resolve('src/preload/index.js'), formats: ['cjs'] },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
    plugins: [react()],
  },
})

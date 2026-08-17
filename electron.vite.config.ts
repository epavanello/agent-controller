import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [tailwindcss(), svelte()],
    resolve: {
      alias: {
        $lib: resolve('src/renderer/src/lib'),
        '@shared': resolve('src/shared')
      }
    }
  }
})

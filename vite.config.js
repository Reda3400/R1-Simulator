import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { r1Plugin } from './scripts/r1-vite-plugin.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss(), r1Plugin()],
})

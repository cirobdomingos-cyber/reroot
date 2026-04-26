import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  server: {
    watch: {
      ignored: ['**/.venv/**', '**/backend/**', '**/synthetic_data/**', '**/node_modules/**'],
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon.svg'],
      manifest: {
        id: 'app.aue',
        name: 'auê — Curitiba que acontece',
        short_name: 'auê',
        description: 'Tudo o que está acontecendo em Curitiba num lugar só, com a galera junto. Shows, exposições, feiras, oficinas — atualizado todo dia.',
        theme_color: '#E8623F',
        background_color: '#FCF5EB',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/?source=pwa',
        lang: 'pt-BR',
        categories: ['lifestyle', 'social', 'entertainment'],
        icons: [
          // SVG comes first so capable browsers prefer it (always crisp,
          // already on the new auê brand). The PNGs below are fallbacks
          // and STILL SHOW THE OLD REROOT LEAF until regenerated — see
          // scripts/render-icons.js (run `node scripts/render-icons.js`).
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
          },
          {
            src: 'icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icon-1024x1024.png',
            sizes: '1024x1024',
            type: 'image/png',
          },
          {
            src: 'icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // injectManifest lets us write a custom src/sw.js with our push handler
      // while still getting Workbox precaching. generateSW (the default) would
      // not allow custom event listeners like `push`.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
    }),
  ],
})

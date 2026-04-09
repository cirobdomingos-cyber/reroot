import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon.svg'],
      manifest: {
        id: 'app.reroot',
        name: 'Reroot — Vida Social',
        short_name: 'Reroot',
        description: 'Redescubra sua vida social em Curitiba. Eventos com baixa pressão, locais acolhedores e uma comunidade que entende você.',
        theme_color: '#7A9E7E',
        background_color: '#FAF8F5',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/?source=pwa',
        lang: 'pt-BR',
        categories: ['lifestyle', 'social'],
        icons: [
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

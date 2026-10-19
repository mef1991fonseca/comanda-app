import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Comandá',
        short_name: 'Comandá',
        description: 'Comandas, cocina, caja y stock de tu restaurante, desde el celular.',
        lang: 'es-AR',
        start_url: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#F2F4F1',
        theme_color: '#1F4D3A',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
})

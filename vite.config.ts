import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Served from the custom domain https://chargeit.wwweeeiii.com/ (root path).
// Set PAGES_BASE=/chargeit/ only if you ever go back to <user>.github.io/chargeit/.
const base = process.env.PAGES_BASE || "/";

export default defineConfig({
  base,
  server: { host: true },
  preview: { host: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        advancedChunks: { groups: [{ name: "maplibre", test: /maplibre-gl/ }] },
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.svg", "logo.svg", "icons/apple-touch-icon.png"],
      manifest: {
        id: base,
        name: "ChargeIt — EV chargers near you",
        short_name: "ChargeIt",
        description: "Realtime EV charging points across Singapore: live availability, charging speed, provider and price.",
        lang: "en-SG",
        start_url: base,
        scope: base,
        display: "standalone",
        orientation: "portrait",
        background_color: "#070B16",
        theme_color: "#070B16",
        categories: ["navigation", "travel", "utilities"],
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
        shortcuts: [
          { name: "Free chargers near me", short_name: "Free now", url: `${base}?free=1`, icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2}"],
        globIgnores: ["demo/**", "**/*-cyrillic*", "**/*-greek*", "**/*-vietnamese*", "**/*.woff"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            // Basemap style, glyphs, sprites and vector tiles.
            urlPattern: ({ url }) => url.hostname === "tiles.openfreemap.org",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "chargeit-map",
              expiration: { maxEntries: 600, maxAgeSeconds: 14 * 24 * 3600, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith("/demo/chargers.json"),
            handler: "CacheFirst",
            options: { cacheName: "chargeit-demo", expiration: { maxEntries: 1, maxAgeSeconds: 7 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
});

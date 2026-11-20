import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/static/v2/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../static/v2",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: "src/right-panel-entry.tsx",
      output: {
        entryFileNames: "assets/panel-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks: {
          vendor: ["react", "react-dom", "zustand"],
        },
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});

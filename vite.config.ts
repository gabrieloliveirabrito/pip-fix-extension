import { cpSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const optionsAssetsDir = resolve(projectRoot, "dist/options/assets");

function cleanLegacyOptionsAssets(): Plugin {
  return {
    name: "clean-legacy-options-assets",
    buildStart() {
      try {
        for (const name of readdirSync(optionsAssetsDir)) {
          if (/^index-[A-Za-z0-9_-]+\.(js|css)$/.test(name)) {
            unlinkSync(resolve(optionsAssetsDir, name));
          }
        }
      } catch {
        // dist/options/assets ainda não existe
      }
    },
  };
}

function copyManifest(): Plugin {
  const manifest = resolve(projectRoot, "manifest.json");
  return {
    name: "copy-manifest",
    buildStart() {
      this.addWatchFile(manifest);
    },
    closeBundle() {
      const dist = resolve(projectRoot, "dist");
      mkdirSync(resolve(dist, "options"), { recursive: true });
      cpSync(manifest, resolve(dist, "manifest.json"));
    },
  };
}

export default defineConfig({
  root: resolve(projectRoot, "src/options"),
  base: "./",
  plugins: [react(), tailwindcss(), cleanLegacyOptionsAssets(), copyManifest()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(projectRoot, "dist/options"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/index[extname]",
      },
    },
  },
});

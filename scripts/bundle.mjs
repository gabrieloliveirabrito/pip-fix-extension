import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");

const options = {
  entryPoints: {
    background: "src/background.ts",
    bridge: "src/bridge.ts",
    "options-bridge": "src/options-bridge.ts",
    "pip-keep": "src/pip-keep.ts",
  },
  bundle: true,
  format: "iife",
  target: "es2022",
  outdir: "dist",
  define: {
    // Sempre a options empacotada. A URL do Vite quebrava no Firefox temporário
    // (ícone abria 5173 sem a ponte options-bridge injetada).
    __DEV_OPTIONS__: JSON.stringify(""),
  },
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}

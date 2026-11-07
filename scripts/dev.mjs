import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const children = [];

function run(args) {
  const child = spawn("npx", args, { stdio: "inherit", shell: true });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal || code === 0 || code === null) return;
    stop();
    process.exit(code);
  });
  return child;
}

function stop() {
  for (const child of children) child.kill();
}

process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});

run(["node", "scripts/bundle.mjs", "--watch"]);

while (
  !existsSync("dist/background.js") ||
  !existsSync("dist/bridge.js") ||
  !existsSync("dist/options-bridge.js") ||
  !existsSync("dist/pip-keep.js")
) {
  await delay(200);
}

const optionsBuild = spawnSync("npx", ["vite", "build"], { stdio: "inherit", shell: true });
if (optionsBuild.status !== 0) {
  process.exit(optionsBuild.status ?? 1);
}

// Empacota a tela de configuração em dist/options a cada save (sem servidor Vite).
run(["vite", "build", "--watch"]);

console.log("Dev pronto: dist/ em watch (scripts + options).");
console.log("No about:debugging, Recarregar o complemento e abrir pelo ícone (options empacotada).");
console.log("Firefox não abre sozinho. Opcional: pnpm run dev:firefox");

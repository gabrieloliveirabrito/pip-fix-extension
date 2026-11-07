import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Versão inválida: ${value}`);
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error("Versão fora do limite");
  return parts;
}

export function updateVersion(root, branch, floor) {
  if (!["development", "main"].includes(branch)) throw new Error(`Branch inválida: ${branch}`);
  const readJson = (name) => JSON.parse(readFileSync(resolve(root, name), "utf8"));
  const pkg = readJson("package.json");
  const manifest = readJson("manifest.json");
  const versionPath = resolve(root, "VERSION");
  const candidates = [pkg.version, manifest.version];
  if (existsSync(versionPath)) candidates.push(readFileSync(versionPath, "utf8").trim());
  if (floor) candidates.push(floor);
  const versions = candidates.map(parseVersion);
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const next = [...versions.at(-1)];
  if (branch === "main") next[2] += 1;
  const version = next.join(".");
  parseVersion(version);

  // Valide todos os arquivos antes de gravar qualquer alteração.
  let lock;
  if (branch === "main" && existsSync(resolve(root, "package-lock.json"))) {
    lock = readJson("package-lock.json");
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
  }
  const writeJson = (name, data) => writeFileSync(resolve(root, name), `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(versionPath, `${version}\n`);
  if (branch === "main") {
    pkg.version = version;
    manifest.version = version;
    writeJson("package.json", pkg);
    writeJson("manifest.json", manifest);
    if (lock) writeJson("package-lock.json", lock);
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(updateVersion(process.cwd(), process.argv[2], process.argv[3]));
}

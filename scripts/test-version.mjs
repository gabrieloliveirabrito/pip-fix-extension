import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateVersion } from "./version.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pip-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
  write("package.json", { version: "1.0.0", scripts: { build: "original" } });
  write("manifest.json", { version: "1.0.0", permissions: ["storage"] });
  write("package-lock.json", { version: "1.0.0", packages: { "": { version: "1.0.0" }, dep: { version: "9.0.0" } } });
  return { root, read: (name) => readFileSync(join(root, name), "utf8") };
}

test("development cria VERSION sem modificar pacote, manifest ou lockfile", (t) => {
  const { root, read } = fixture(t);
  const before = ["package.json", "manifest.json", "package-lock.json"].map(read);
  assert.equal(updateVersion(root, "development"), "1.0.0");
  assert.equal(read("VERSION"), "1.0.0\n");
  assert.deepEqual(["package.json", "manifest.json", "package-lock.json"].map(read), before);
});

test("main incrementa patch e sincroniza os arquivos sem alterar dependências", (t) => {
  const { root, read } = fixture(t);
  writeFileSync(join(root, "VERSION"), "1.0.9\n");
  assert.equal(updateVersion(root, "main"), "1.0.10");
  assert.equal(read("VERSION"), "1.0.10\n");
  for (const name of ["package.json", "manifest.json", "package-lock.json"]) {
    assert.equal(JSON.parse(read(name)).version, "1.0.10");
  }
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.packages[""].version, "1.0.10");
  assert.equal(lock.packages.dep.version, "9.0.0");
  assert.equal(JSON.parse(read("package.json")).scripts.build, "original");
});

test("histórico impede downgrade depois de merge com versão antiga", (t) => {
  const { root, read } = fixture(t);
  assert.equal(updateVersion(root, "main", "2.0.7"), "2.0.8");
  assert.equal(read("VERSION"), "2.0.8\n");
});

test("development sincroniza versão já publicada sem outro bump", (t) => {
  const { root } = fixture(t);
  assert.equal(updateVersion(root, "development", "1.0.3"), "1.0.3");
  assert.equal(updateVersion(root, "development", "1.0.3"), "1.0.3");
});

test("branch ou versão inválida falha antes de gravar", (t) => {
  const { root, read } = fixture(t);
  const before = read("package.json");
  assert.throws(() => updateVersion(root, "feature"), /Branch inválida/);
  assert.throws(() => updateVersion(root, "main", "1.0.0-beta"), /Versão inválida/);
  assert.equal(read("package.json"), before);
});

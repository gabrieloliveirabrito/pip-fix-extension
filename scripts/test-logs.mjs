import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  stdin: { contents: 'export * from "./src/shared"; export * from "./src/telemetry"; export * from "./src/log-store"; export * from "./src/timeline";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
});
const {
  LogStore, Telemetry, retainLogs, isLogEntry, eventEvidence, logOutcome, describeLog,
  filterLogs, defaultFilters, exportLogs, summarizeLogs, unseenCount, MAX_LOG_BYTES, snapshotFromStorage,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const entry = (id, extra = {}) => ({ id: String(id), ts: 1700000000000 + Number(id || 0), event: "video-playing", detail: "", ...extra });
function fixture(initial = {}) {
  let data = structuredClone(initial);
  let writes = 0;
  let fail = false;
  const health = [];
  const store = new LogStore({
    read: async () => structuredClone(data),
    write: async (values) => {
      if (fail) throw new Error("quota indisponível");
      writes += 1; data = { ...data, ...structuredClone(values) };
    },
  }, (error) => health.push(error));
  return { store, health, data: () => data, writes: () => writes, fail: (value) => { fail = value; } };
}

test("NotAllowedError é falha, estacionamento é preservação e promessa não confirma janela", () => {
  assert.equal(eventEvidence("erro", "NotAllowedError").outcome, "failed");
  assert.equal(logOutcome(entry(1, { event: "erro", outcome: "completed" })), "failed");
  assert.equal(eventEvidence("video-removido", "removeChild estacionado").outcome, "preserved");
  assert.equal(eventEvidence("pip-request-ok", "").outcome, "completed");
  assert.equal(eventEvidence("handoff", "").outcome, "completed");
  assert.equal(eventEvidence("pip-native-enter", "").outcome, "confirmed");
});

test("pausa-blur e abertura Firefox inferida não comprovam janela fechada/aberta", () => {
  assert.equal(eventEvidence("pip-fecha", "pausa-blur").evidence, "inferred");
  assert.equal(eventEvidence("pip-firefox", "abre ativacao-viva").outcome, "unconfirmed");
  assert.match(describeLog(entry(1, { event: "pip-firefox-probe", detail: "pausa-preservada" })), /preservada/);
});

test("legados e eventos desconhecidos são preservados; opcionais inválidos são rejeitados", () => {
  const legacy = { ts: 1, event: "evento-futuro", detail: "original" };
  assert.equal(isLogEntry(legacy), true);
  assert.deepEqual(snapshotFromStorage({ logs: [legacy] }).logs, [legacy]);
  for (const extra of [{ sequence: -1 }, { evidence: "yes" }, { outcome: false }, { videoId: 7 }, { state: {} }, { ts: Infinity }]) {
    assert.equal(isLogEntry({ ...legacy, ...extra }), false);
  }
});

test("telemetria correlaciona sessão, vídeo, sequência, operação e snapshot sem URL", () => {
  globalThis.document = { hasFocus: () => false, visibilityState: "visible" };
  const rows = [];
  const telemetry = new Telemetry((value) => rows.push(value));
  const video = { isConnected: true, paused: true, ended: false, readyState: 4, videoWidth: 854, videoHeight: 480, src: "https://secret.invalid/token" };
  const operationId = telemetry.startOperation(video);
  telemetry.record("pip-request", "", video);
  video.paused = false;
  telemetry.record("pip-request-ok", "", video);
  telemetry.record("video-inserido", "", { ...video });
  assert.equal(rows[0].sessionId, rows[2].sessionId);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[0].sequence + 1, rows[1].sequence);
  assert.equal(rows[0].videoId, rows[1].videoId);
  assert.notEqual(rows[0].videoId, rows[2].videoId);
  assert.equal(rows[1].operationId, operationId);
  assert.equal(rows[0].state.paused, true);
  assert.equal(rows[1].state.paused, false);
  assert.equal(JSON.stringify(rows).includes("secret.invalid"), false);
  assert.equal(rows.every(isLogEntry), true);
  telemetry.endOperation(video, operationId);
  assert.equal(telemetry.operation(video), undefined);
});

test("mesmo evento nativo só é registrado uma vez; falha na instrumentação não propaga", () => {
  const telemetry = new Telemetry(() => { throw new Error("falha no canal"); });
  const event = {};
  assert.equal(telemetry.firstNativeEvent(event), true);
  assert.equal(telemetry.firstNativeEvent(event), false);
  assert.equal(telemetry.firstNativeEvent({}), true);
  assert.doesNotThrow(() => telemetry.record("video-pause"));
});

test("retenção mantém últimos 5.000 registros em ordem", () => {
  const rows = Array.from({ length: 5100 }, (_, index) => entry(index));
  const result = retainLogs(rows);
  assert.equal(result.logs.length, 5000);
  assert.equal(result.discarded, 100);
  assert.equal(result.logs[0].id, "100");
});

test("limite de bytes mede UTF-8, incluindo separadores e caracteres multibyte", () => {
  const rows = [entry(1, { detail: "á🎵".repeat(70) }), entry(2, { detail: "á🎵".repeat(70) })];
  const limit = Buffer.byteLength(JSON.stringify([rows[1]]));
  assert.deepEqual(retainLogs(rows, 5000, limit).logs, [rows[1]]);
  assert.equal(retainLogs(rows, 5000, limit - 1).logs.length, 0);
  assert.equal(retainLogs([entry(1, { detail: "x".repeat(MAX_LOG_BYTES) })]).logs.length, 0);
});

test("lotes concorrentes de duas sessões não sobrescrevem eventos e gravam a cada 50", async () => {
  const f = fixture({ logs: [entry(0)] });
  const a = f.store.dispatch({ type: "append", entries: Array.from({ length: 25 }, (_, index) => entry(index + 1, { sessionId: "A" })) });
  const b = f.store.dispatch({ type: "append", entries: Array.from({ length: 25 }, (_, index) => entry(index + 26, { sessionId: "B" })) });
  await Promise.all([a, b]);
  assert.equal(f.writes(), 1);
  assert.equal(f.data().logs.length, 51);
  assert.deepEqual(f.data().logs.map((row) => row.id), Array.from({ length: 51 }, (_, index) => String(index)));
});

test("lote parcial é persistido pelo timer de 250ms", async () => {
  const f = fixture();
  const start = Date.now();
  await f.store.dispatch({ type: "append", entries: [entry(1)] });
  assert.ok(Date.now() - start >= 200);
  assert.equal(f.writes(), 1);
});

test("clear é uma barreira: anteriores somem, posteriores ficam, ativação não perde logs", async () => {
  const f = fixture();
  const before = f.store.dispatch({ type: "append", entries: [entry(1)] });
  const clear = f.store.dispatch({ type: "clear" });
  const after = f.store.dispatch({ type: "append", entries: [entry(2)] });
  const enabled = f.store.dispatch({ type: "enabled", value: false });
  await Promise.all([before, clear, after, enabled]);
  assert.deepEqual(f.data().logs.map((row) => row.event), ["video-playing", "extensao-desativada"]);
  assert.equal(f.data().logs[0].id, "2");
  assert.equal(f.data().enabled, false);
  assert.equal(f.data().logMeta.received, 2);
});

test("falha na gravação mantém histórico anterior, informa saúde e não quebra a fila", async () => {
  const f = fixture({ logs: [entry(0)] });
  f.fail(true);
  const failed = f.store.dispatch({ type: "append", entries: [entry(1)] });
  f.store.flush();
  await assert.rejects(failed, /quota/);
  assert.equal(f.data().logs.length, 1);
  assert.match((await f.store.dispatch({ type: "snapshot" })).meta.error, /quota/);
  f.fail(false);
  const next = f.store.dispatch({ type: "append", entries: [entry(2)] });
  f.store.flush(); await next;
  assert.deepEqual(f.data().logs.map((row) => row.id), ["0", "2"]);
  assert.equal(f.health.at(-1), undefined);
});

test("reenvio do mesmo ID não duplica histórico nem contadores", async () => {
  const f = fixture({ logs: [entry(1)] });
  const result = f.store.dispatch({ type: "append", entries: [entry(1), entry(2), entry(2)] });
  f.store.flush(); await result;
  assert.deepEqual(f.data().logs.map((row) => row.id), ["1", "2"]);
  assert.equal(f.data().logMeta.received, 2);
});

test("ler snapshot não modifica nem trunca o histórico existente", async () => {
  const rows = Array.from({ length: 5100 }, (_, index) => entry(index));
  const f = fixture({ logs: rows });
  assert.equal((await f.store.dispatch({ type: "snapshot" })).logs.length, 5100);
  assert.equal(f.writes(), 0);
});

test("retenção atualiza recebidos, descartados, início disponível e revisão sem resetar na leitura", async () => {
  const rows = Array.from({ length: 5000 }, (_, index) => entry(index));
  const f = fixture({ logs: rows, logMeta: { received: 5000, discarded: 0, revision: 11 } });
  const appended = f.store.dispatch({ type: "append", entries: [entry(5000), entry(5001)] });
  f.store.flush(); await appended;
  const snapshot = await f.store.dispatch({ type: "snapshot" });
  assert.equal(snapshot.logs.length, 5000);
  assert.equal(snapshot.meta.received, 5002);
  assert.equal(snapshot.meta.discarded, 2);
  assert.equal(snapshot.meta.firstAvailableAt, entry(2).ts);
  assert.equal(snapshot.meta.revision, 12);
  const cleared = await f.store.dispatch({ type: "clear" });
  assert.equal(cleared.meta.revision, 13);
  assert.equal(cleared.meta.received, 0);
  assert.equal(cleared.meta.discarded, 0);
});

test("comandos inválidos não entram na fila nem modificam o storage", async () => {
  const f = fixture();
  await assert.rejects(f.store.dispatch({ type: "append", entries: [entry(1, { evidence: "invalid" })] }), /inválido/);
  await assert.rejects(f.store.dispatch({ type: "append", entries: Array.from({ length: 51 }, (_, index) => entry(index)) }), /máximo 50/);
  await assert.rejects(f.store.dispatch({ type: "enabled", value: "yes" }), /inválido/);
  assert.equal(f.writes(), 0);
});

test("filtros combinados não confundem video-1 de sessões diferentes; exportação mantém bruto", () => {
  const rows = [entry(1, { sessionId: "A", videoId: "video-1", event: "erro", detail: "NotAllowedError" }), entry(2, { sessionId: "B", videoId: "video-1" })];
  const filtered = filterLogs(rows, { ...defaultFilters, session: "A", video: "A/video-1", kind: "errors", query: "notallowed" });
  assert.deepEqual(filtered, [rows[0]]);
  assert.deepEqual(JSON.parse(exportLogs(filtered, "json")).logs, filtered);
  assert.match(exportLogs(filtered, "text"), /1\. .*Z.*Falha/);
  assert.match(exportLogs(filtered, "text"), /NotAllowedError/);
  assert.equal(filterLogs(rows, { ...defaultFilters, category: "midia" }).length, 1);
});

test("resumo conta operações únicas, não transforma promessa em sinal e pausa usa recebidos", () => {
  const rows = [entry(1, { operationId: "A", evidence: "attempt" }), entry(2, { operationId: "A", evidence: "attempt" }),
    entry(3, { operationId: "A", outcome: "completed", event: "pip-request-ok" }),
    entry(4, { operationId: "B", event: "erro" }), entry(5, { operationId: "B", event: "pip-request-erro" })];
  const summary = summarizeLogs(rows);
  assert.deepEqual([summary.attempts, summary.completed, summary.failed], [1, 1, 1]);
  assert.equal(summary.lastSignal, undefined);
  assert.equal(unseenCount(6200, 5100), 1100);
  assert.equal(unseenCount(0, 5100), 0);
});

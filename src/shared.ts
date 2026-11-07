export const LOG_KEY = "logs";
export const ENABLED_KEY = "enabled";
export const LOG_META_KEY = "logMeta";
export const MAX_LOGS = 5000;
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type Evidence = "observed" | "inferred" | "attempt" | "result";
export type Outcome = "confirmed" | "completed" | "failed" | "preserved" | "unconfirmed";
export type MediaState = {
  connected: boolean; paused: boolean; ended: boolean; readyState: number;
  width: number; height: number; focused: boolean; visibility: string;
};
export type LogEntry = {
  ts: number; event: string; detail: string;
  id?: string; sessionId?: string; sequence?: number; videoId?: string;
  operationId?: string; origin?: string; evidence?: Evidence; outcome?: Outcome;
  state?: MediaState;
};
export type LogCategory = "pip" | "remocao" | "midia" | "extensao" | "outro";
export type LogMeta = { revision: number; discarded: number; received: number; firstAvailableAt?: number; error?: string };
export type StorageSnapshot = { enabled: boolean; logs: LogEntry[]; meta: LogMeta };
export type OptionsValues = { enabled?: boolean; logs?: LogEntry[] };
export type LogCommand =
  | { type: "append"; entries: LogEntry[] }
  | { type: "clear" }
  | { type: "enabled"; value: boolean }
  | { type: "snapshot" };
export type LogReply = { ok: true; snapshot?: StorageSnapshot } | { ok: false; error: string };

const stringFields = ["id", "sessionId", "videoId", "operationId", "origin"] as const;
export function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts) || Math.abs(entry.ts) > 8640000000000000 ||
      typeof entry.event !== "string" || typeof entry.detail !== "string") return false;
  if (stringFields.some((key) => entry[key] !== undefined && typeof entry[key] !== "string")) return false;
  if (entry.sequence !== undefined && (!Number.isSafeInteger(entry.sequence) || Number(entry.sequence) < 0)) return false;
  if (entry.evidence !== undefined && !["observed", "inferred", "attempt", "result"].includes(String(entry.evidence))) return false;
  if (entry.outcome !== undefined && !["confirmed", "completed", "failed", "preserved", "unconfirmed"].includes(String(entry.outcome))) return false;
  if (entry.state !== undefined) {
    if (!entry.state || typeof entry.state !== "object") return false;
    const state = entry.state as Record<string, unknown>;
    if (["connected", "paused", "ended", "focused"].some((key) => typeof state[key] !== "boolean")) return false;
    if (["readyState", "width", "height"].some((key) => typeof state[key] !== "number" || !Number.isFinite(state[key]))) return false;
    if (typeof state.visibility !== "string") return false;
  }
  return true;
}

export function logCategory(event: string): LogCategory {
  if (["video-removido", "video-desconectou"].includes(event)) return "remocao";
  if (["ativo", "pausado", "pip-disable-flag"].includes(event)) return "midia";
  if (event.startsWith("extensao-")) return "extensao";
  if (event.startsWith("pip-") || ["detectado", "desativado", "destruido", "handoff", "ignorado", "erro", "modo-video"].includes(event)) return "pip";
  return event.startsWith("video-") ? "midia" : "outro";
}

const descriptions: Record<string, string> = {
  "pip-abre": "Sinal de abertura do PiP", "pip-fecha": "Sinal de encerramento da sessão PiP",
  "pip-enter": "Proteção vinculada ao vídeo", "pip-leave": "Saída da sessão de proteção",
  "pip-native-enter": "Entrada no PiP informada pelo navegador", "pip-native-leave": "Saída do PiP informada pelo navegador",
  "pip-request": "Solicitação de abertura do PiP", "pip-request-ok": "Solicitação de abertura concluída",
  "pip-request-erro": "Solicitação de abertura falhou", "pip-handoff-start": "Transferência de PiP iniciada",
  handoff: "Solicitação de transferência concluída", erro: "Falha na operação do PiP",
  detectado: "Vídeo identificado para proteção", desativado: "Proteção do vídeo liberada",
  destruido: "Vídeo protegido ficou sem mídia disponível", ignorado: "Transferência dispensada: vídeo anterior ainda utilizável",
  "video-removido": "Remoção do vídeo interceptada", "video-desconectou": "Vídeo desconectado da página",
  "video-inserido": "Vídeo inserido na página", "video-criado": "Elemento de vídeo criado",
  "video-src": "Origem da mídia alterada", "video-load": "Carregamento da mídia solicitado",
  "video-quadro": "Disponibilidade de imagem alterada", "video-pause": "Vídeo pausado",
  "video-play": "Reprodução solicitada", "video-playing": "Vídeo em reprodução",
  "video-emptied": "Dados de mídia esvaziados", "video-waiting": "Vídeo aguardando dados",
  "video-loadedmetadata": "Metadados carregados", "video-loadeddata": "Dados do vídeo carregados",
  ativo: "Vídeo protegido em reprodução", pausado: "Vídeo protegido pausado",
  "pip-firefox": "Sinal do PiP nativo do Firefox", "pip-firefox-probe": "Verificação do PiP no Firefox",
  "pip-getter": "Estado da API PiP alterado", "pip-exit-chamado": "Saída do PiP solicitada",
  "extensao-ativada": "Extensão ativada", "extensao-desativada": "Extensão desativada",
  "telemetry-session": "Sessão de coleta iniciada",
};

export function describeLog(entry: LogEntry) {
  if (entry.event === "pip-native-toggle") return "Solicitação de PiP recebida da interface do Firefox";
  if (entry.event === "pip-firefox") return entry.detail.startsWith("abre")
    ? "Sinal de abertura do PiP nativo do Firefox" : "Sessão de proteção do Firefox encerrada";
  if (entry.event === "pip-getter") return entry.detail === "presente"
    ? "API passou a indicar um vídeo em PiP" : "API deixou de indicar um vídeo em PiP";
  if (entry.event === "video-removido" && entry.detail.includes("estacionado")) return "Vídeo preservado antes da remoção";
  if (entry.event === "pip-firefox-probe" && entry.detail.includes("pausa-preservada")) return "Pausa observada; proteção preservada";
  return descriptions[entry.event] ?? `Evento: ${entry.event}`;
}
export function logOutcome(entry: LogEntry): Outcome | undefined {
  if (entry.event === "erro" || entry.event === "pip-request-erro") return "failed";
  if (entry.event === "video-removido" && entry.detail.includes("estacionado")) return "preserved";
  return entry.outcome;
}
export function isActionLog(entry: LogEntry) {
  return entry.evidence === "attempt" || entry.evidence === "result" ||
    ["handoff", "erro", "ignorado", "detectado", "desativado", "video-removido", "pip-leave", "pip-fecha"].includes(entry.event) ||
    entry.event.startsWith("pip-request");
}
export function isPipSignal(entry: LogEntry) {
  return ["pip-abre", "pip-fecha", "pip-firefox", "pip-native-enter", "pip-native-leave", "pip-getter", "pip-document-abre", "pip-document-fecha"].includes(entry.event);
}

const encoder = new TextEncoder();
export function retainLogs(logs: LogEntry[], maxCount = MAX_LOGS, maxBytes = MAX_LOG_BYTES) {
  const sizes = logs.map((entry) => encoder.encode(JSON.stringify(entry)).byteLength);
  let bytes = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, logs.length - 1);
  let start = 0;
  while (start < logs.length && (logs.length - start > maxCount || bytes > maxBytes)) {
    bytes -= sizes[start] + (logs.length - start > 1 ? 1 : 0);
    start += 1;
  }
  return { logs: logs.slice(start), discarded: start };
}
export function trimLogs(logs: LogEntry[]) { return retainLogs(logs).logs; }
export function snapshotFromStorage(data: Record<string, unknown>): StorageSnapshot {
  const logs = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY].filter(isLogEntry) : [];
  const raw = data[LOG_META_KEY] as Partial<LogMeta> | undefined;
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    enabled: data[ENABLED_KEY] !== false, logs,
    meta: { revision: count(raw?.revision), discarded: count(raw?.discarded), received: Math.max(logs.length, count(raw?.received)),
      firstAvailableAt: logs[0]?.ts, error: typeof raw?.error === "string" ? raw.error : undefined },
  };
}

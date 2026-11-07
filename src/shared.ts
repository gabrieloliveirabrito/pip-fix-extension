export const LOG_KEY = "logs";
export const ENABLED_KEY = "enabled";
export const MAX_LOGS = 500;

export type LogEntry = {
  ts: number;
  event: string;
  detail: string;
};

export type LogCategory = "pip" | "remocao" | "midia" | "extensao" | "outro";

const PIP_STATE_EVENTS = new Set([
  "detectado",
  "desativado",
  "destruido",
  "handoff",
  "ignorado",
  "erro",
  "modo-video",
]);

export function logCategory(event: string): LogCategory {
  if (event === "video-removido" || event === "video-desconectou") return "remocao";
  if (event === "ativo" || event === "pausado" || event === "pip-disable-flag") return "midia";
  if (event.startsWith("extensao-")) return "extensao";
  if (event.startsWith("pip-") || PIP_STATE_EVENTS.has(event)) return "pip";
  if (event.startsWith("video-")) return "midia";
  return "outro";
}

export function isRoutineMediaEvent(event: string) {
  return logCategory(event) === "midia";
}

/** Extensão tentou manter/reativar PiP ou registrou que não deve restaurar. */
export type ExtensionPipDecision = "reativou" | "nao-restaurar";

export function extensionPipDecision(entry: LogEntry): ExtensionPipDecision | null {
  const { event, detail } = entry;
  if (event === "handoff") return "reativou";
  if (event === "detectado" && detail.includes("solto")) return "reativou";
  if (event === "video-removido") {
    return detail.includes("estacionado") ? "reativou" : null;
  }
  if (event === "erro") {
    return detail.includes("espera-encerrada") ? "nao-restaurar" : "reativou";
  }
  if (event === "ignorado" || event === "desativado" || event === "pip-leave" || event === "pip-fecha") {
    return "nao-restaurar";
  }
  return null;
}

export function isExtensionPipDecisionLog(entry: LogEntry) {
  return extensionPipDecision(entry) !== null;
}

export function trimLogs(logs: LogEntry[]) {
  const next = [...logs];
  while (next.length > MAX_LOGS) {
    const dropAt = next.findIndex((entry) => isRoutineMediaEvent(entry.event));
    if (dropAt >= 0) next.splice(dropAt, 1);
    else next.shift();
  }
  return next;
}

export type StorageSnapshot = {
  enabled: boolean;
  logs: LogEntry[];
};

export type OptionsValues = {
  enabled?: boolean;
  logs?: LogEntry[];
};

export function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as LogEntry;
  return typeof entry.ts === "number" && typeof entry.event === "string" && typeof entry.detail === "string";
}

export function snapshotFromStorage(data: Record<string, unknown>): StorageSnapshot {
  const logs = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY].filter(isLogEntry) : [];
  return {
    enabled: data[ENABLED_KEY] !== false,
    logs,
  };
}

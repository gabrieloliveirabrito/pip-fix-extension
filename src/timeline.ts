import { describeLog, isActionLog, isPipSignal, logCategory, logOutcome, type LogEntry } from "./shared";

export const evidenceLabels = { observed: "Observado", inferred: "Inferido", attempt: "Tentativa", result: "Resultado" };
export const outcomeLabels = {
  confirmed: "Sinal confirmado", completed: "SolicitaÃ§Ã£o concluÃ­da", failed: "Falhou",
  preserved: "Preservado", unconfirmed: "Sem confirmaÃ§Ã£o da janela",
};
export const categoryLabels = { pip: "PiP", remocao: "RemoÃ§Ãµes", midia: "MÃ­dia", extensao: "ExtensÃ£o", outro: "Outros" };
export type TimelineFilters = { session: string; video: string; category: string; kind: string; query: string };
export const defaultFilters: TimelineFilters = { session: "all", video: "all", category: "all", kind: "all", query: "" };

export function filterLogs(logs: LogEntry[], filters: TimelineFilters) {
  const query = filters.query.trim().toLocaleLowerCase("pt-BR");
  return logs.filter((entry) => {
    if (filters.session !== "all" && (entry.sessionId ?? "legacy") !== filters.session) return false;
    const video = entry.videoId ? `${entry.sessionId ?? "legacy"}/${entry.videoId}` : "none";
    if (filters.video !== "all" && video !== filters.video) return false;
    if (filters.category !== "all" && logCategory(entry.event) !== filters.category) return false;
    if (filters.kind === "errors" && logOutcome(entry) !== "failed") return false;
    if (filters.kind === "actions" && !isActionLog(entry)) return false;
    if (query && !`${describeLog(entry)} ${JSON.stringify(entry)}`.toLocaleLowerCase("pt-BR").includes(query)) return false;
    return true;
  });
}

export function summarizeLogs(logs: LogEntry[]) {
  const count = (match: (entry: LogEntry) => boolean) => new Set(logs.filter(match).map((entry, index) =>
    entry.operationId ?? entry.id ?? `legacy-${index}`)).size;
  return {
    attempts: count((entry) => entry.evidence === "attempt"),
    completed: count((entry) => logOutcome(entry) === "completed"),
    failed: count((entry) => logOutcome(entry) === "failed"),
    lastSignal: [...logs].reverse().find(isPipSignal),
  };
}

const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  fractionalSecondDigits: 3,
});
export function formatLogTime(ts: number) { return timeFormatter.format(new Date(ts)); }

export function exportLogs(logs: LogEntry[], format: "json" | "text") {
  // Storage order is authoritative for arrival; sequence disambiguates equal timestamps per session.
  if (format === "json") return JSON.stringify({ formatVersion: 1, order: "arrival-oldest-first", logs }, null, 2);
  return logs.map((entry, index) => [
    `${index + 1}. ${new Date(entry.ts).toISOString()} | ${describeLog(entry)}`,
    `${entry.evidence ? evidenceLabels[entry.evidence] : "Registro legado"} | ${logOutcome(entry) ? outcomeLabels[logOutcome(entry)!] : "Sem resultado registrado"}`,
    JSON.stringify(entry),
  ].join("\n")).join("\n\n");
}

export function logKey(entry: LogEntry) {
  return entry.id ?? `legacy:${JSON.stringify(entry)}`;
}

export function unseenCount(received: number, frozenReceived: number) {
  return Math.max(0, received - frozenReceived);
}

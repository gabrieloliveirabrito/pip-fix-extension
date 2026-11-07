import { logCommand } from "../log-client";
import {
  type OptionsValues,
  type StorageSnapshot,
} from "../shared";

export const PAGE_SOURCE = "ytm-pip-options";
export const BRIDGE_SOURCE = "ytm-pip-options-bridge";

type BridgeMessage = {
  source?: string;
  type?: string;
  requestId?: string;
  snapshot?: StorageSnapshot;
  error?: string;
};

function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== "object") return false;
  return (value as BridgeMessage).source === BRIDGE_SOURCE;
}

export function isPackagedOptionsPage() {
  return Boolean(globalThis.chrome?.storage?.local);
}

export async function waitForViteDevServer() {
  if (!import.meta.env.DEV) return;
  const host = location.hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return;
  let lastError: unknown = new Error("Servidor Vite indisponível");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${location.origin}/`, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`Servidor Vite respondeu ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(String(lastError));
}

export function ask(message: { type: "get" } | { type: "set"; values: OptionsValues }, timeoutMs = 800) {
  const requestId = crypto.randomUUID();
  return new Promise<StorageSnapshot>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      reject(new Error("Tempo esgotado aguardando a ponte da extensão (options-bridge.js)."));
    }, timeoutMs);
    function onReply(event: MessageEvent) {
      if (event.source !== window || !isBridgeMessage(event.data)) return;
      if (event.data.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onReply);
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.snapshot) resolve(event.data.snapshot);
      else reject(new Error("Resposta incompleta da ponte."));
    }
    window.addEventListener("message", onReply);
    window.postMessage({ source: PAGE_SOURCE, requestId, ...message }, location.origin);
  });
}

export function connectDevBridge(
  onSnapshot: (snapshot: StorageSnapshot) => void,
  onStatus: (status: "connecting" | "ready" | "reconnecting") => void,
) {
  let stopped = false;
  let timer = 0;
  let pollTimer = 0;
  let connected = false;

  const onLive = (event: MessageEvent) => {
    if (stopped || event.source !== window || !isBridgeMessage(event.data)) return;
    if (event.data.type !== "snapshot" || !event.data.snapshot) return;
    onSnapshot(event.data.snapshot);
    connected = true;
    onStatus("ready");
  };

  const ping = () => {
    if (stopped) return;
    onStatus(connected ? "reconnecting" : "connecting");
    ask({ type: "get" }, 1200)
      .then((snapshot) => {
        if (stopped) return;
        onSnapshot(snapshot);
        connected = true;
        onStatus("ready");
      })
      .catch(() => {
        if (stopped) return;
        timer = window.setTimeout(ping, 800);
      });
  };

  const poll = () => {
    if (stopped) return;
    ask({ type: "get" }, 1500)
      .then((snapshot) => {
        if (stopped) return;
        onSnapshot(snapshot);
        connected = true;
        onStatus("ready");
      })
      .catch(() => {});
  };

  window.addEventListener("message", onLive);
  ping();
  pollTimer = window.setInterval(poll, 1500);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(pollTimer);
    window.removeEventListener("message", onLive);
  };
}

export function readPackagedSnapshot() {
  return logCommand({ type: "snapshot" });
}

export async function writePackaged(values: OptionsValues) {
  if (values.logs !== undefined) {
    if (values.logs.length) throw new Error("Somente a limpeza do histórico é permitida.");
    await logCommand({ type: "clear" });
  }
  if (values.enabled !== undefined) await logCommand({ type: "enabled", value: values.enabled });
}

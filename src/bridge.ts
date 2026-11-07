import { ENABLED_KEY, isLogEntry } from "./shared";
import { logCommand } from "./log-client";

const PAGE_SOURCE = "ytm-pip-keep";
const BRIDGE_SOURCE = "ytm-pip-bridge";

type PageMessage = {
  source?: string;
  type?: string;
  entry?: unknown;
};

let enabledCache = true;
let storageReady = false;

function postEnabled() {
  window.postMessage({ source: BRIDGE_SOURCE, type: "enabled", value: enabledCache }, "*");
}

function rememberEnabled(value: unknown) {
  enabledCache = value !== false;
  storageReady = true;
  postEnabled();
}

chrome.storage.local.get(ENABLED_KEY, (data) => {
  rememberEnabled(data[ENABLED_KEY]);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[ENABLED_KEY]) rememberEnabled(changes[ENABLED_KEY].newValue);
});

function appendLog(entry: unknown) {
  if (!isLogEntry(entry)) return;
  void logCommand({ type: "append", entries: [entry] }).catch((error) => {
    console.warn("PiP: falha ao registrar evento", error instanceof Error ? error.message : "armazenamento indisponível");
  });
}

window.addEventListener("message", (event: MessageEvent<PageMessage>) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE) return;
  if (data.type === "hello") {
    if (storageReady) postEnabled();
    return;
  }
  if (data.type === "log") appendLog(data.entry);
});

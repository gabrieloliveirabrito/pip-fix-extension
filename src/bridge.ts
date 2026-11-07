import { ENABLED_KEY, isLogEntry, LOG_KEY, trimLogs } from "./shared";

const PAGE_SOURCE = "ytm-pip-keep";
const BRIDGE_SOURCE = "ytm-pip-bridge";

type PageMessage = {
  source?: string;
  type?: string;
  entry?: unknown;
};

let enabledCache = true;
let storageReady = false;
let writeChain: Promise<void> = Promise.resolve();

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
  const nextEntry = entry;
  writeChain = writeChain
    .then(
      () =>
        new Promise<void>((resolve) => {
          chrome.storage.local.get(LOG_KEY, (stored) => {
            const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY].filter(isLogEntry) : [];
            logs.push(nextEntry);
            chrome.storage.local.set({ [LOG_KEY]: trimLogs(logs) }, () => resolve());
          });
        }),
    )
    .catch(() => undefined);
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

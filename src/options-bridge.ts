import { ENABLED_KEY, LOG_KEY, type OptionsValues, snapshotFromStorage } from "./shared";

const PAGE_SOURCE = "ytm-pip-options";
const BRIDGE_SOURCE = "ytm-pip-options-bridge";

type PageMessage = {
  source?: string;
  type?: string;
  requestId?: string;
  values?: OptionsValues;
};

function postSnapshot(requestId?: string) {
  chrome.storage.local.get([ENABLED_KEY, LOG_KEY], (data) => {
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "snapshot",
        requestId,
        snapshot: snapshotFromStorage(data),
      },
      location.origin,
    );
  });
}

window.addEventListener("message", (event: MessageEvent<PageMessage>) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE) return;
  if (message.type === "get") {
    postSnapshot(message.requestId);
    return;
  }
  if (message.type === "set" && message.values) {
    chrome.storage.local.set(message.values, () => postSnapshot(message.requestId));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[ENABLED_KEY] && !changes[LOG_KEY]) return;
  postSnapshot();
});

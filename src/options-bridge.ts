import { ENABLED_KEY, LOG_KEY, LOG_META_KEY, type OptionsValues } from "./shared";
import { logCommand } from "./log-client";

const PAGE_SOURCE = "ytm-pip-options";
const BRIDGE_SOURCE = "ytm-pip-options-bridge";

type PageMessage = { source?: string; type?: string; requestId?: string; values?: OptionsValues };
function reply(payload: object) {
  window.postMessage({ source: BRIDGE_SOURCE, ...payload }, location.origin);
}
async function postSnapshot(requestId?: string) {
  try { reply({ type: "snapshot", requestId, snapshot: await logCommand({ type: "snapshot" }) }); }
  catch (error) { reply({ type: "snapshot", requestId, error: error instanceof Error ? error.message : String(error) }); }
}
window.addEventListener("message", (event: MessageEvent<PageMessage>) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE) return;
  if (message.type === "get") { void postSnapshot(message.requestId); return; }
  if (message.type !== "set" || !message.values) return;
  const values = message.values;
  void (async () => {
    if (values.logs !== undefined) {
      if (!Array.isArray(values.logs) || values.logs.length) throw new Error("Somente a limpeza do histórico é permitida.");
      await logCommand({ type: "clear" });
    }
    if (values.enabled !== undefined) await logCommand({ type: "enabled", value: values.enabled });
    await postSnapshot(message.requestId);
  })().catch((error) => reply({ requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[ENABLED_KEY] || changes[LOG_KEY] || changes[LOG_META_KEY])) void postSnapshot();
});

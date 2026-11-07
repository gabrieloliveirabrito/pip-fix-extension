import { LogStore } from "./log-store";
import { ENABLED_KEY, LOG_KEY, LOG_META_KEY, type LogCommand } from "./shared";

const store = new LogStore({
  read: () => chrome.storage.local.get([ENABLED_KEY, LOG_KEY, LOG_META_KEY]),
  write: (values) => chrome.storage.local.set(values),
}, (error) => {
  void chrome.runtime.sendMessage({ source: "pip-log-health", error: error ?? null }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.source !== "pip-log-store") return;
  const command = message.command as LogCommand | undefined;
  if (!command || !["append", "clear", "enabled", "snapshot"].includes(command.type)) {
    respond({ ok: false, error: "Comando inválido." });
    return;
  }
  // Player content scripts may append only; settings commands come from options.
  const settingsPage = (sender.url ?? "").startsWith(chrome.runtime.getURL("")) ||
    /^https?:\/\/(localhost|127\.0\.0\.1):5173\//.test(sender.url ?? "");
  if (!settingsPage && command.type !== "append" && command.type !== "snapshot") {
    respond({ ok: false, error: "Comando não permitido nesta página." });
    return;
  }
  void store.dispatch(command).then(
    (snapshot) => respond(command.type === "append" ? { ok: true } : { ok: true, snapshot }),
    (error) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

function openPackagedOptions() {
  chrome.runtime.openOptionsPage();
}

function openDevOptions(devOptionsUrl: string) {
  chrome.tabs.create({ url: devOptionsUrl });
}

chrome.action.onClicked.addListener(() => {
  const devOptionsUrl = __DEV_OPTIONS__;
  if (devOptionsUrl) openDevOptions(devOptionsUrl);
  else openPackagedOptions();
});

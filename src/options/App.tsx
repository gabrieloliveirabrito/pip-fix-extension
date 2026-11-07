import { useEffect, useState } from "react";
import { Root, Thumb } from "@radix-ui/react-switch";
import * as Tabs from "@radix-ui/react-tabs";
import {
  ENABLED_KEY,
  LOG_KEY,
  extensionPipDecision,
  isExtensionPipDecisionLog,
  logCategory,
  type LogEntry,
  type OptionsValues,
  type StorageSnapshot,
  snapshotFromStorage,
  trimLogs,
} from "../shared";
import {
  ask,
  connectDevBridge,
  readPackagedSnapshot,
  writePackaged,
} from "./bridge-client";
import { ErrorScreen } from "./components/ErrorScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { LogList } from "./components/LogList";

const MAIN_LOGS = "eventos";
const MAIN_ACTION = "acao";

const TAB_ALL = "todos";
const TAB_PIP = "pip";
const TAB_REMOVAL = "remocoes";
const TAB_MEDIA = "midia";

const VALID_LOG_TABS = new Set([TAB_ALL, TAB_PIP, TAB_REMOVAL, TAB_MEDIA]);

function matchesLogTab(entry: LogEntry, tab: string) {
  if (tab === TAB_ALL) return true;
  if (tab === TAB_REMOVAL) return logCategory(entry.event) === "remocao";
  if (tab === TAB_PIP) {
    const category = logCategory(entry.event);
    return category === "pip" || category === "extensao" || category === "outro";
  }
  if (tab === TAB_MEDIA) return logCategory(entry.event) === "midia";
  return true;
}

function logSubTabTriggerClass(tab: string) {
  if (tab === TAB_REMOVAL) {
    return "shrink-0 rounded-md border border-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-400 outline-none hover:bg-zinc-900 data-[state=active]:border-rose-800 data-[state=active]:bg-rose-950 data-[state=active]:text-rose-200";
  }
  if (tab === TAB_PIP) {
    return "shrink-0 rounded-md border border-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-400 outline-none hover:bg-zinc-900 data-[state=active]:border-sky-800 data-[state=active]:bg-sky-950 data-[state=active]:text-sky-200";
  }
  if (tab === TAB_MEDIA) {
    return "shrink-0 rounded-md border border-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-400 outline-none hover:bg-zinc-900 data-[state=active]:border-zinc-600 data-[state=active]:bg-zinc-900 data-[state=active]:text-zinc-200";
  }
  return "shrink-0 rounded-md border border-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-400 outline-none hover:bg-zinc-900 data-[state=active]:border-emerald-800 data-[state=active]:bg-emerald-950 data-[state=active]:text-emerald-200";
}

const mainTabTriggerClass =
  "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 outline-none hover:bg-zinc-900 data-[state=active]:border-zinc-500 data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100";

type Props = {
  mode: "dev" | "packaged";
};

export function App({ mode }: Props) {
  const packaged = mode === "packaged";
  const [enabled, setEnabled] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [mainTab, setMainTab] = useState(MAIN_LOGS);
  const [logTab, setLogTab] = useState(TAB_PIP);
  const [boot, setBoot] = useState<"loading" | "ready">(packaged ? "loading" : "loading");
  const [bridge, setBridge] = useState<"connecting" | "ready" | "reconnecting">(
    packaged ? "ready" : "connecting",
  );
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (packaged) {
      let active = true;
      readPackagedSnapshot()
        .then((snapshot) => {
          if (!active) return;
          setEnabled(snapshot.enabled);
          setLogs(snapshot.logs);
          setBoot("ready");
        })
        .catch((error) => {
          if (!active) return;
          setActionError(error);
          setBoot("ready");
        });
      const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
        if (area !== "local") return;
        if (changes[ENABLED_KEY]) setEnabled(changes[ENABLED_KEY].newValue !== false);
        if (changes[LOG_KEY]) {
          const snapshot = snapshotFromStorage({ [LOG_KEY]: changes[LOG_KEY].newValue });
          setLogs(snapshot.logs);
        }
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => {
        active = false;
        chrome.storage.onChanged.removeListener(onChanged);
      };
    }

    setBoot("ready");
    return connectDevBridge(
      (snapshot) => {
        setEnabled(snapshot.enabled);
        setLogs(snapshot.logs);
        setActionError(null);
      },
      setBridge,
    );
  }, [packaged]);

  async function read(): Promise<StorageSnapshot> {
    if (packaged) return readPackagedSnapshot();
    return ask({ type: "get" });
  }

  async function write(values: OptionsValues) {
    if (packaged) {
      await writePackaged(values);
      return;
    }
    await ask({ type: "set", values });
  }

  async function runAction(action: () => Promise<void>) {
    try {
      setActionError(null);
      await action();
    } catch (error) {
      setActionError(error);
    }
  }

  async function onToggle(checked: boolean) {
    setEnabled(checked);
    await runAction(async () => {
      const current = await read();
      const next = [...current.logs];
      next.push({
        ts: Date.now(),
        event: checked ? "extensao-ativada" : "extensao-desativada",
        detail: "",
      });
      const trimmed = trimLogs(next);
      setLogs(trimmed);
      await write({ [ENABLED_KEY]: checked, [LOG_KEY]: trimmed });
    });
  }

  if (packaged && boot === "loading") {
    return <LoadingScreen label="Carregando configuração…" />;
  }

  if (!packaged && bridge !== "ready") {
    return (
      <LoadingScreen
        label={bridge === "reconnecting" ? "Reconectando à extensão…" : "Carregando…"}
        detail={
          bridge === "connecting"
            ? "Abra pelo ícone da extensão (options empacotada), não pelo localhost:5173. Se já estiver no moz-extension://, recarregue o complemento no about:debugging."
            : "A extensão recarregou. Tentando de novo."
        }
      />
    );
  }

  if (actionError) {
    return (
      <ErrorScreen
        error={actionError}
        title="Falha ao falar com a extensão"
        hint={packaged ? "Não consegui ler ou gravar o storage local." : "A ponte do localhost falhou nesta ação."}
        onRetry={() => {
          setActionError(null);
          if (!packaged) return;
          setBoot("loading");
          readPackagedSnapshot()
            .then((snapshot) => {
              setEnabled(snapshot.enabled);
              setLogs(snapshot.logs);
              setBoot("ready");
            })
            .catch(setActionError);
        }}
      />
    );
  }

  const activeLogTab = VALID_LOG_TABS.has(logTab) ? logTab : TAB_PIP;
  const pipCount = logs.filter((entry) => matchesLogTab(entry, TAB_PIP)).length;
  const removalCount = logs.filter((entry) => matchesLogTab(entry, TAB_REMOVAL)).length;
  const mediaCount = logs.filter((entry) => matchesLogTab(entry, TAB_MEDIA)).length;

  function rowsForLogTab(tab: string) {
    return [...logs].reverse().filter((entry) => matchesLogTab(entry, tab));
  }
  const actionLogs = logs.filter(isExtensionPipDecisionLog);
  const actionRows = [...actionLogs].reverse();
  const actionReativou = actionLogs.filter((e) => extensionPipDecision(e) === "reativou").length;
  const actionNao = actionLogs.filter((e) => extensionPipDecision(e) === "nao-restaurar").length;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10 text-zinc-100">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">PiP persistente no YouTube Music</h1>
        <p className="text-sm text-zinc-400">
          Eventos gerais do player e uma aba só com o que a extensão fez para manter ou recusar o PiP.
        </p>
      </header>
      <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
        <label className="text-sm font-medium" htmlFor="ytm-pip-enabled">
          Ativado
        </label>
        <Root
          id="ytm-pip-enabled"
          checked={enabled}
          onCheckedChange={(checked) => {
            void onToggle(checked);
          }}
          className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full bg-zinc-700 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-400 data-[state=checked]:bg-emerald-500"
        >
          <Thumb className="block size-5 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[22px]" />
        </Root>
      </div>
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-300">Registros</h2>
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={() => {
              void runAction(async () => {
                setLogs([]);
                setLogTab(TAB_PIP);
                setMainTab(MAIN_LOGS);
                await write({ [LOG_KEY]: [] });
              });
            }}
          >
            Limpar
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-sm text-zinc-500">
            Nenhum evento ainda.
          </p>
        ) : (
          <Tabs.Root value={mainTab} onValueChange={setMainTab} className="flex min-h-0 flex-col gap-4">
            <Tabs.List aria-label="Tipo de registro" className="flex flex-wrap gap-2">
              <Tabs.Trigger value={MAIN_LOGS} className={mainTabTriggerClass}>
                Eventos {logs.length}
              </Tabs.Trigger>
              <Tabs.Trigger value={MAIN_ACTION} className={mainTabTriggerClass}>
                Ação do PiP {actionLogs.length}
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value={MAIN_LOGS} className="outline-none">
              <Tabs.Root value={activeLogTab} onValueChange={setLogTab} className="flex min-h-0 flex-col gap-3">
                <Tabs.List aria-label="Categorias de evento" className="flex flex-wrap gap-1 pb-1">
                  <Tabs.Trigger value={TAB_PIP} className={logSubTabTriggerClass(TAB_PIP)}>
                    PiP {pipCount}
                  </Tabs.Trigger>
                  <Tabs.Trigger value={TAB_REMOVAL} className={logSubTabTriggerClass(TAB_REMOVAL)}>
                    Remoções {removalCount}
                  </Tabs.Trigger>
                  <Tabs.Trigger value={TAB_MEDIA} className={logSubTabTriggerClass(TAB_MEDIA)}>
                    Mídia {mediaCount}
                  </Tabs.Trigger>
                  <Tabs.Trigger value={TAB_ALL} className={logSubTabTriggerClass(TAB_ALL)}>
                    Todos {logs.length}
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value={TAB_PIP} className="outline-none">
                  <LogList rows={rowsForLogTab(TAB_PIP)} />
                </Tabs.Content>
                <Tabs.Content value={TAB_REMOVAL} className="outline-none">
                  <LogList rows={rowsForLogTab(TAB_REMOVAL)} />
                </Tabs.Content>
                <Tabs.Content value={TAB_MEDIA} className="outline-none">
                  <LogList rows={rowsForLogTab(TAB_MEDIA)} />
                </Tabs.Content>
                <Tabs.Content value={TAB_ALL} className="outline-none">
                  <LogList rows={rowsForLogTab(TAB_ALL)} />
                </Tabs.Content>
              </Tabs.Root>
            </Tabs.Content>

            <Tabs.Content value={MAIN_ACTION} className="outline-none">
              <p className="mb-2 text-xs text-zinc-500">
                Handoff, estacionamento e erros de reabertura ({actionReativou} reativou) · desativado, ignorado e
                fechamento e ignorado ({actionNao} nao restaurar).
              </p>
              <LogList
                rows={actionRows}
                showDecision
                emptyLabel="Nenhuma decisao da extensao sobre PiP ainda."
              />
            </Tabs.Content>
          </Tabs.Root>
        )}
      </section>
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Root, Thumb } from "@radix-ui/react-switch";
import { ENABLED_KEY, LOG_KEY, LOG_META_KEY, MAX_LOGS, logCategory,
  snapshotFromStorage, type StorageSnapshot, type OptionsValues } from "../shared";
import { categoryLabels, defaultFilters } from "../timeline";
import { evidenceLabels, exportLogs, filterLogs, formatLogTime, summarizeLogs, unseenCount, type TimelineFilters } from "../timeline";
import { describeLog } from "../shared";
import { ask, connectDevBridge, readPackagedSnapshot, writePackaged } from "./bridge-client";
import { LogList } from "./components/LogList";

const empty = snapshotFromStorage({});
type Props = { mode: "dev" | "packaged" };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function App({ mode }: Props) {
  const packaged = mode === "packaged";
  const [snapshot, setSnapshot] = useState<StorageSnapshot>(empty);
  const [frozen, setFrozen] = useState<StorageSnapshot | null>(null);
  const [filters, setFilters] = useState<TimelineFilters>(defaultFilters);
  const [limit, setLimit] = useState(200);
  const [layout, setLayout] = useState<"table" | "timeline">(() => {
    try { return localStorage.getItem("pip-log-layout") === "timeline" ? "timeline" : "table"; }
    catch { return "table"; }
  });
  const [ready, setReady] = useState(false);
  const [bridge, setBridge] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const accept = (next: StorageSnapshot) => {
      if (!active) return;
      setSnapshot((previous) => next.meta.revision >= previous.meta.revision ? next : previous);
      setStorageError(next.meta.error ?? null); setReady(true);
    };
    const onHealth = (message: { source?: string; error?: string | null }) => {
      if (message?.source === "pip-log-health") setStorageError(message.error ?? null);
    };
    if (packaged) chrome.runtime.onMessage.addListener(onHealth);
    if (!packaged) {
      const disconnect = connectDevBridge(accept, setBridge);
      return () => { active = false; disconnect(); };
    }
    void readPackagedSnapshot().then(accept).catch((reason) => {
      if (active) { setError(messageOf(reason)); setReady(true); }
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      if (!(changes[LOG_KEY] || changes[ENABLED_KEY] || changes[LOG_META_KEY])) return;
      setSnapshot((previous) => {
        const next = snapshotFromStorage({
          [LOG_KEY]: changes[LOG_KEY]?.newValue ?? previous.logs,
          [ENABLED_KEY]: changes[ENABLED_KEY]?.newValue ?? previous.enabled,
          [LOG_META_KEY]: changes[LOG_META_KEY]?.newValue ?? previous.meta,
        });
        return next.meta.revision >= previous.meta.revision ? next : previous;
      });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
      chrome.runtime.onMessage.removeListener(onHealth);
    };
  }, [packaged]);

  const view = frozen ?? snapshot;
  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of view.logs) {
      const session = entry.sessionId ?? "legacy";
      counts.set(session, (counts.get(session) ?? 0) + 1);
    }
    return counts;
  }, [view.logs]);
  const sessions = useMemo(() => [...sessionCounts.keys()].reverse(), [sessionCounts]);
  const sessionRows = useMemo(() => filterLogs(view.logs, { ...defaultFilters, session: filters.session }), [view.logs, filters.session]);
  const videos = useMemo(() => [...new Set(sessionRows.flatMap((entry) => entry.videoId ? [`${entry.sessionId ?? "legacy"}/${entry.videoId}`] : []))], [sessionRows]);
  const categoryScope = useMemo(() => filterLogs(view.logs, { ...filters, category: "all" }), [view.logs, filters]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of categoryScope) {
      const category = logCategory(entry.event);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return counts;
  }, [categoryScope]);
  const matched = useMemo(() => filters.category === "all" ? categoryScope : categoryScope.filter((entry) => logCategory(entry.event) === filters.category), [categoryScope, filters.category]);
  const rows = useMemo(() => [...matched].reverse(), [matched]);
  const summary = useMemo(() => summarizeLogs(sessionRows), [sessionRows]);
  const newCount = frozen ? unseenCount(snapshot.meta.received, frozen.meta.received) : 0;
  const updateFilter = (key: keyof TimelineFilters, value: string) => {
    setFilters((previous) => ({ ...previous, [key]: value, ...(key === "session" ? { video: "all" } : {}) }));
    setLimit(200);
  };

  async function write(values: OptionsValues) {
    if (packaged) { await writePackaged(values); return; }
    await ask({ type: "set", values }, 5000);
  }
  async function action(fn: () => void | Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }
  function download(format: "json" | "text", all: boolean) {
    const data = all ? view.logs : matched;
    const blob = new Blob([exportLogs(data, format)], { type: format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `pip-logs-${all ? "historico" : "filtrados"}-${Date.now()}.${format === "json" ? "json" : "txt"}`;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  return <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8 text-zinc-100 sm:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-medium uppercase tracking-[0.2em] text-sky-300">YouTube Music · Diagnóstico</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Linha do tempo do PiP</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">Eventos observados, indícios e resultados das ações da extensão. O histórico não comprova que a janela continua aberta.</p>
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
        <label htmlFor="ytm-pip-enabled" className="text-sm">Proteção ativada</label>
        <Root id="ytm-pip-enabled" checked={snapshot.enabled} disabled={busy || !ready} onCheckedChange={(value) => void action(() => write({ enabled: value }))}
          className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full bg-zinc-700 outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50 data-[state=checked]:bg-emerald-500">
          <Thumb className="block size-5 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[22px]" />
        </Root>
      </div>
    </header>

    {!ready && <p role="status" className="text-sm text-zinc-400">{packaged ? "Carregando registros…" : "Conectando à extensão…"}</p>}
    {!packaged && bridge !== "ready" && <p role="status" className="text-sm text-amber-200">Ponte de desenvolvimento: {bridge}. A configuração empacotada pode ser aberta pelo ícone da extensão.</p>}
    {(error || storageError) && <div role="alert" className="rounded-xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-200">
      <p>{error}</p>{storageError && <p>Falha na coleta/armazenamento: {storageError}. Alguns eventos podem não ter sido gravados.</p>}
      <button type="button" className="log-button mt-3" disabled={busy} onClick={() => void action(async () => {
        const next = packaged ? await readPackagedSnapshot() : await ask({ type: "get" }, 5000);
        setSnapshot((previous) => next.meta.revision >= previous.meta.revision ? next : previous);
        setStorageError(next.meta.error ?? null); setReady(true);
      })}>Tentar ler novamente</button>
    </div>}

    <section aria-label="Resumo da sessão selecionada" className="grid gap-3 sm:grid-cols-3">
      {[['Tentativas', summary.attempts], ['Solicitações concluídas', summary.completed], ['Falhas', summary.failed]].map(([label, value]) =>
        <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"><p className="text-xs text-zinc-400">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>)}
      <div className="rounded-xl border border-zinc-800 p-4 sm:col-span-3">
        <p className="text-xs text-zinc-400">Último sinal no histórico da sessão selecionada · {filters.session === "all" ? "todas as sessões" : filters.session === "legacy" ? "sem sessão identificada" : filters.session.slice(0, 8)}</p>
        {summary.lastSignal ? <p className="mt-2 text-sm">{describeLog(summary.lastSignal)} · {summary.lastSignal.evidence ? evidenceLabels[summary.lastSignal.evidence] : "Registro legado"}<span className="mt-1 block font-mono text-xs text-zinc-400">{formatLogTime(summary.lastSignal.ts)}</span></p> : <p className="mt-2 text-sm text-zinc-400">Nenhum sinal de PiP registrado.</p>}
        <p className="mt-2 text-xs text-zinc-500">Contagens por operação identificada; registros antigos ou sem operação são contados individualmente. Filtros de categoria e busca não alteram este resumo.</p>
      </div>
    </section>

    <section aria-label="Filtros dos registros" className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className="log-label sm:col-span-2 lg:col-span-4">Buscar evento, detalhe ou operação
        <input className="log-input" type="search" value={filters.query} onChange={(event) => updateFilter("query", event.target.value)} placeholder="Ex.: NotAllowedError, pausa-preservada, video-2" />
      </label>
      <label className="log-label">Sessão<select className="log-input" value={filters.session} onChange={(event) => updateFilter("session", event.target.value)}>
        <option value="all">Todas as sessões</option>{sessions.map((session) => <option key={session} value={session}>{session === "legacy" ? "Sem sessão identificada" : `Sessão ${session.slice(0, 8)}`} ({sessionCounts.get(session)})</option>)}
      </select></label>
      <label className="log-label">Vídeo<select className="log-input" value={filters.video} onChange={(event) => updateFilter("video", event.target.value)}>
        <option value="all">Todos os vídeos</option><option value="none">Sem identificação</option>{videos.map((video) => <option key={video} value={video}>{video.split('/')[1]} · {video.split('/')[0].slice(0, 8)}</option>)}
      </select></label>
      <label className="log-label">Categoria<select className="log-input" value={filters.category} onChange={(event) => updateFilter("category", event.target.value)}>
        <option value="all">Todas as categorias</option>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label} ({categoryCounts.get(key) ?? 0})</option>)}
      </select></label>
      <label className="log-label">Exibir<select className="log-input" value={filters.kind} onChange={(event) => updateFilter("kind", event.target.value)}>
        <option value="all">Todos os eventos</option><option value="errors">Somente falhas</option><option value="actions">Ações da extensão</option>
      </select></label>
      <button type="button" className="log-button w-fit" onClick={() => { setFilters(defaultFilters); setLimit(200); }}>Remover filtros</button>
    </section>

    <section aria-label="Histórico de eventos" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-sm font-medium">{matched.length} registros encontrados · {view.logs.length} disponíveis</h2>
          <p role="status" className="mt-1 text-xs text-zinc-400">{frozen ? `Visualização pausada · ${newCount} novos registros recebidos. A coleta continua.` : "Atualização ao vivo · mais recentes primeiro"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div role="group" aria-label="Formato dos registros" className="flex gap-1">
            {([['table', 'Tabela compacta'], ['timeline', 'Linha do tempo']] as const).map(([value, label]) =>
              <button key={value} type="button" aria-pressed={layout === value}
                className={`log-button ${layout === value ? "border-sky-500 text-sky-200" : ""}`}
                onClick={() => {
                  setLayout(value);
                  try { localStorage.setItem("pip-log-layout", value); } catch { /* Preference remains available for this page. */ }
                }}>{label}</button>)}
          </div>
          <button type="button" className="log-button" aria-pressed={!!frozen} onClick={() => setFrozen(frozen ? null : snapshot)}>{frozen ? "Retomar visualização" : "Pausar visualização"}</button>
          <button type="button" className="log-button" disabled={busy || !ready} onClick={() => void action(async () => {
            await write({ logs: [] }); setFrozen(null); setFilters(defaultFilters); setLimit(200);
          })}>Limpar histórico</button>
        </div>
      </div>
      <p className="text-xs text-zinc-500">Até {MAX_LOGS.toLocaleString("pt-BR")} registros ou 4 MiB. {snapshot.meta.discarded} descartados por retenção desde a última limpeza.
        {view.meta.firstAvailableAt !== undefined && ` Histórico disponível desde ${formatLogTime(view.meta.firstAvailableAt)}.`}</p>
      <LogList key={`${layout}/${filters.session}/${filters.video}/${filters.category}/${filters.kind}/${filters.query}`} rows={rows} limit={limit} mode={layout} />
      {matched.length > limit && <button type="button" className="log-button self-center" onClick={() => setLimit((value) => value + 200)}>Carregar mais 200 ({Math.min(limit, matched.length)} de {matched.length})</button>}
      <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
        <span className="w-full text-xs text-zinc-400">Exportação em ordem de recebimento, do mais antigo para o mais recente. {frozen ? "Usa o histórico congelado na pausa." : "Inclui todos os registros disponíveis no escopo escolhido."}</span>
        <button type="button" className="log-button" disabled={busy} onClick={() => void action(() => download("json", false))}>Filtrados · JSON</button>
        <button type="button" className="log-button" disabled={busy} onClick={() => void action(() => download("text", false))}>Filtrados · Texto</button>
        <button type="button" className="log-button" disabled={busy} onClick={() => void action(() => download("json", true))}>Histórico completo · JSON</button>
        <button type="button" className="log-button" disabled={busy} onClick={() => void action(() => download("text", true))}>Histórico completo · Texto</button>
      </div>
    </section>
  </main>;
}

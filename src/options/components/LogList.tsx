import { PureComponent, createRef } from "react";
import { describeLog, logOutcome, type LogEntry } from "../../shared";
import { evidenceLabels, formatLogTime, logKey, outcomeLabels } from "../../timeline";

type Props = { rows: LogEntry[]; limit?: number; emptyLabel?: string };
type Anchor = { key: string; offset: number; scrollTop: number } | null;

export class LogList extends PureComponent<Props> {
  private viewport = createRef<HTMLOListElement>();
  private readingAnchor?: { key: string; index: number };

  private rememberPosition = () => {
    const viewport = this.viewport.current;
    if (!viewport) return;
    if (viewport.scrollTop < 2) {
      if (this.readingAnchor) { this.readingAnchor = undefined; this.forceUpdate(); }
      return;
    }
    const top = viewport.getBoundingClientRect().top;
    const nodes = Array.from(viewport.querySelectorAll<HTMLElement>("[data-row-key]"));
    const index = nodes.findIndex((row) => row.getBoundingClientRect().bottom > top);
    if (index >= 0) this.readingAnchor = { key: nodes[index].dataset.rowKey!, index };
  };

  getSnapshotBeforeUpdate(): Anchor {
    const viewport = this.viewport.current;
    if (!viewport || viewport.scrollTop < 2) return null;
    const top = viewport.getBoundingClientRect().top;
    const first = Array.from(viewport.querySelectorAll<HTMLElement>("[data-row-key]"))
      .find((row) => row.getBoundingClientRect().bottom > top);
    return first ? { key: first.dataset.rowKey!, offset: first.getBoundingClientRect().top - top, scrollTop: viewport.scrollTop } : null;
  }

  componentDidUpdate(_previous: Props, _state: unknown, anchor: Anchor) {
    const viewport = this.viewport.current;
    if (!viewport || !anchor) return;
    const row = Array.from(viewport.querySelectorAll<HTMLElement>("[data-row-key]"))
      .find((node) => node.dataset.rowKey === anchor.key);
    viewport.scrollTop = row
      ? viewport.scrollTop + row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
      : anchor.scrollTop;
  }

  render() {
    const { rows, limit = 200, emptyLabel = "Nenhum registro corresponde aos filtros." } = this.props;
    const occurrences = new Map<string, number>();
    const keyed = rows.map((entry) => {
      const base = logKey(entry);
      const count = occurrences.get(base) ?? 0;
      occurrences.set(base, count + 1);
      return { entry, key: `${base}:${count}` };
    });
    const anchorIndex = this.readingAnchor ? keyed.findIndex((row) => row.key === this.readingAnchor!.key) : -1;
    // Move the rendered window with the reading anchor rather than evicting its
    // oldest row every time a new record arrives at the top of a full page.
    const start = anchorIndex >= 0 ? Math.max(0, anchorIndex - this.readingAnchor!.index) : 0;
    const visible = keyed.slice(start, start + limit);
    return <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button className="log-button" type="button" onClick={() => {
          this.readingAnchor = undefined;
          this.forceUpdate(() => this.viewport.current?.scrollTo({ top: 0 }));
        }}>Voltar aos mais recentes</button>
      </div>
      <ol ref={this.viewport} onScroll={this.rememberPosition} aria-label="Linha do tempo dos registros" tabIndex={0}
        style={{ overflowAnchor: "none" }} className="max-h-[65vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
        {!rows.length && <li className="p-8 text-sm text-zinc-400">{emptyLabel}</li>}
        {visible.map(({ entry, key }) => {
          const outcome = logOutcome(entry);
          const tone = outcome === "failed" ? "text-rose-300" : entry.evidence === "inferred" ? "text-amber-200" : "text-sky-200";
          return <li key={key} data-row-key={key} className="border-b border-zinc-800 p-4 last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
              <time dateTime={new Date(entry.ts).toISOString()} className="font-mono">{formatLogTime(entry.ts)}</time>
              <span className={tone}>{entry.evidence ? evidenceLabels[entry.evidence] : "Registro legado"}</span>
              {outcome && <span className={tone}>{outcomeLabels[outcome]}</span>}
              {entry.videoId && <span>{entry.videoId}</span>}
              {entry.sessionId && <span title={entry.sessionId}>sessão {entry.sessionId.slice(0, 8)}</span>}
            </div>
            <p className="mt-2 text-sm font-medium text-zinc-100">{describeLog(entry)}</p>
            <details className="mt-2 text-xs text-zinc-400">
              <summary className="w-fit cursor-pointer rounded py-1 text-zinc-300 outline-none focus-visible:ring-2 focus-visible:ring-sky-400">Detalhes técnicos · {entry.event}</summary>
              <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 break-all">
                <dt>Evento</dt><dd>{entry.event}</dd>
                <dt>Origem</dt><dd>{entry.origin ?? "Não registrada"}</dd>
                <dt>Operação</dt><dd>{entry.operationId ?? "Não registrada"}</dd>
                <dt>Sequência</dt><dd>{entry.sequence ?? "Não registrada"}</dd>
                <dt>Detalhe</dt><dd className="whitespace-pre-wrap">{entry.detail || "—"}</dd>
              </dl>
              <pre className="overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-900 p-3">{JSON.stringify(entry, null, 2)}</pre>
            </details>
          </li>;
        })}
      </ol>
    </div>;
  }
}

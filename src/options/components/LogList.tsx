import { extensionPipDecision, logCategory, type ExtensionPipDecision, type LogEntry } from "../../shared";

type Props = {
  rows: LogEntry[];
  showDecision?: boolean;
  emptyLabel?: string;
};

function eventTone(event: string, decision: ExtensionPipDecision | null) {
  if (decision === "reativou") return "text-emerald-300";
  if (decision === "nao-restaurar") return "text-amber-300";
  const category = logCategory(event);
  if (category === "remocao") return "text-rose-400";
  if (category === "pip" || category === "extensao") return "text-sky-300";
  if (category === "midia") return "text-zinc-500";
  return "text-emerald-300";
}

function decisionLabel(decision: ExtensionPipDecision | null) {
  if (decision === "reativou") return "reativou";
  if (decision === "nao-restaurar") return "nao restaurar";
  return "";
}

export function LogList({ rows, showDecision = false, emptyLabel = "Nenhum evento nesta aba." }: Props) {
  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-sm text-zinc-500">{emptyLabel}</p>;
  }

  return (
    <ol className="max-h-[70vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-950">
      {rows.map((entry, index) => {
        const decision = showDecision ? extensionPipDecision(entry) : null;
        return (
          <li
            key={`${entry.ts}-${entry.event}-${index}`}
            className="grid grid-cols-1 gap-1 border-b border-zinc-800 px-4 py-2 font-mono text-xs last:border-b-0 sm:grid-cols-[11rem_14rem_1fr] sm:gap-3"
          >
            <time className="text-zinc-500">{new Date(entry.ts).toLocaleString("pt-BR")}</time>
            <span className={eventTone(entry.event, decision)}>{entry.event}</span>
            <span className="break-all text-zinc-400">
              {showDecision && decision ? (
                <span className="mr-2 text-zinc-500">[{decisionLabel(decision)}]</span>
              ) : null}
              {entry.detail}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

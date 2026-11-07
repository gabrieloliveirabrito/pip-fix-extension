import { Component, type ReactNode } from "react";

type Props = {
  error: unknown;
  title?: string;
  hint?: string;
  onRetry?: () => void;
};

function formatError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? "",
    };
  }
  return {
    name: "Erro",
    message: typeof error === "string" ? error : JSON.stringify(error, null, 2),
    stack: "",
  };
}

export function ErrorScreen({ error, title = "Algo deu errado", hint, onRetry }: Props) {
  const formatted = formatError(error);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-10 text-zinc-100">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-rose-200">{title}</h1>
        {hint ? <p className="text-sm text-zinc-400">{hint}</p> : null}
      </header>
      <section className="overflow-hidden rounded-xl border border-rose-900/60 bg-zinc-950">
        <div className="border-b border-rose-900/40 bg-rose-950/40 px-4 py-3">
          <p className="font-mono text-sm text-rose-200">
            {formatted.name}: {formatted.message}
          </p>
        </div>
        {formatted.stack ? (
          <pre className="max-h-[50vh] overflow-auto p-4 font-mono text-xs leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
            {formatted.stack}
          </pre>
        ) : null}
      </section>
      {onRetry ? (
        <button
          type="button"
          className="w-fit rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
          onClick={onRetry}
        >
          Tentar de novo
        </button>
      ) : null}
    </main>
  );
}

type BoundaryState = {
  error: unknown;
};

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorScreen
          error={this.state.error}
          title="Erro na interface"
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

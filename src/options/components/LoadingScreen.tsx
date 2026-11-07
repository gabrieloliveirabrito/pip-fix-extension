type Props = {
  label?: string;
  detail?: string;
};

export function LoadingScreen({ label = "Carregando…", detail }: Props) {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-4 px-6 py-10 text-zinc-100">
      <div
        className="size-8 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400"
        aria-hidden
      />
      <p className="text-sm font-medium text-zinc-200">{label}</p>
      {detail ? <p className="max-w-md text-center text-xs text-zinc-500">{detail}</p> : null}
    </main>
  );
}

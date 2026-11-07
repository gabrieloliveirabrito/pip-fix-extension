import {
  ENABLED_KEY, LOG_KEY, LOG_META_KEY, isLogEntry, retainLogs, snapshotFromStorage,
  type LogCommand, type LogEntry, type StorageSnapshot,
} from "./shared";

export type StorageAdapter = {
  read: () => Promise<Record<string, unknown>>;
  write: (values: Record<string, unknown>) => Promise<void>;
};

export class LogStore {
  private chain: Promise<unknown> = Promise.resolve();
  private pending: LogEntry[] = [];
  private listeners: { resolve: (value: StorageSnapshot) => void; reject: (error: unknown) => void }[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private error?: string;
  constructor(private storage: StorageAdapter, private report: (error?: string) => void = () => {}) {}

  private serialize(action: () => Promise<StorageSnapshot>) {
    const next = this.chain.then(async () => {
      try {
        const snapshot = await action();
        if (this.error) { this.error = undefined; this.report(); }
        return snapshot;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.report(this.error);
        throw error;
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }

  private async read() {
    const snapshot = snapshotFromStorage(await this.storage.read());
    snapshot.meta.error = this.error;
    return snapshot;
  }

  dispatch(command: LogCommand): Promise<StorageSnapshot> {
    if (command.type === "append") {
      if (!Array.isArray(command.entries) || command.entries.length > 50 || !command.entries.every(isLogEntry)) {
        return Promise.reject(new Error("Lote de registros inválido (máximo 50)."));
      }
      if (command.entries.length === 0) return this.dispatch({ type: "snapshot" });
      // Partition into batches even when multiple tabs submit at the same time.
      const responses: Promise<StorageSnapshot>[] = [];
      for (const entry of command.entries) {
        this.pending.push(entry);
        responses.push(new Promise((resolve, reject) => this.listeners.push({ resolve, reject })));
        if (this.pending.length === 50) this.flush();
      }
      if (this.pending.length && !this.timer) this.timer = setTimeout(() => this.flush(), 250);
      return Promise.all(responses).then((values) => values.at(-1)!);
    }
    this.flush(); // The barrier is ordered after every earlier append.
    if (command.type === "snapshot") {
      // A read reports health; it must not clear a previous write error.
      const read = this.chain.then(() => this.read());
      this.chain = read.catch(() => {});
      return read;
    }
    return this.serialize(async () => {
      const snapshot = await this.read();
      if (command.type === "clear") {
        snapshot.logs = [];
        snapshot.meta = { revision: snapshot.meta.revision, discarded: 0, received: 0 };
      } else {
        if (typeof command.value !== "boolean") throw new Error("Estado de ativação inválido.");
        snapshot.enabled = command.value;
        const retained = retainLogs([...snapshot.logs, {
          id: crypto.randomUUID(), ts: Date.now(), event: command.value ? "extensao-ativada" : "extensao-desativada",
          detail: "", evidence: "observed", origin: "options",
        }]);
        snapshot.logs = retained.logs;
        snapshot.meta.received += 1;
        snapshot.meta.discarded += retained.discarded;
      }
      return this.save(snapshot);
    });
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    const entries = this.pending;
    const listeners = this.listeners;
    this.pending = [];
    this.listeners = [];
    const result = this.serialize(async () => {
      const snapshot = await this.read();
      const ids = new Set(snapshot.logs.flatMap((entry) => entry.id ? [entry.id] : []));
      const fresh = entries.filter((entry) => {
        if (!entry.id) return true;
        if (ids.has(entry.id)) return false;
        ids.add(entry.id);
        return true;
      });
      const retained = retainLogs([...snapshot.logs, ...fresh]);
      snapshot.logs = retained.logs;
      snapshot.meta.received += fresh.length;
      snapshot.meta.discarded += retained.discarded;
      return this.save(snapshot);
    });
    void result.then(
      (snapshot) => listeners.forEach(({ resolve }) => resolve(snapshot)),
      (error) => listeners.forEach(({ reject }) => reject(error)),
    );
  }

  private async save(snapshot: StorageSnapshot) {
    snapshot.meta.revision += 1;
    snapshot.meta.firstAvailableAt = snapshot.logs[0]?.ts;
    delete snapshot.meta.error;
    await this.storage.write({ [LOG_KEY]: snapshot.logs, [LOG_META_KEY]: snapshot.meta, [ENABLED_KEY]: snapshot.enabled });
    return snapshot;
  }
}

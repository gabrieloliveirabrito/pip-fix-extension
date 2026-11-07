import type { LogCommand, LogReply, StorageSnapshot } from "./shared";

export function logCommand(command: Extract<LogCommand, { type: "append" }>): Promise<void>;
export function logCommand(command: Exclude<LogCommand, { type: "append" }>): Promise<StorageSnapshot>;
export async function logCommand(command: LogCommand): Promise<StorageSnapshot | void> {
  const reply: LogReply = await chrome.runtime.sendMessage({ source: "pip-log-store", command });
  if (!reply || !reply.ok) throw new Error(reply?.error ?? "Sem resposta do armazenamento da extensão.");
  if (command.type === "append") return;
  if (!reply.snapshot) throw new Error("Resposta de armazenamento incompleta.");
  return reply.snapshot;
}

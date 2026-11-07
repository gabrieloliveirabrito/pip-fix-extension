import type { Evidence, LogEntry, Outcome } from "./shared";

// Classification describes evidence only; it never controls PiP behavior.
export function eventEvidence(event: string, detail: string): { evidence: Evidence; outcome?: Outcome; origin: string } {
  if (["erro", "pip-request-erro"].includes(event)) return { evidence: "result", outcome: "failed", origin: "extension" };
  if (["handoff", "pip-request-ok"].includes(event)) return { evidence: "result", outcome: "completed", origin: "request-promise" };
  if (["pip-request", "pip-handoff-start", "pip-exit-chamado"].includes(event)) return { evidence: "attempt", outcome: "unconfirmed", origin: "extension" };
  if (event === "video-removido" && detail.includes("estacionado")) return { evidence: "observed", outcome: "preserved", origin: "dom-hook" };
  if (["pip-native-enter", "pip-native-leave"].includes(event)) return { evidence: "observed", outcome: "confirmed", origin: "browser-event" };
  if (["pip-getter", "pip-document-abre", "pip-document-fecha", "pip-resize"].includes(event)) return { evidence: "observed", outcome: "confirmed", origin: "pip-api" };
  if (["pip-abre", "pip-fecha", "pip-firefox", "pip-enter", "pip-leave", "detectado"].includes(event)) return { evidence: "inferred", outcome: "unconfirmed", origin: "extension-state" };
  if (event === "pip-firefox-probe") return { evidence: "observed", outcome: detail.includes("pausa-preservada") ? "preserved" : undefined, origin: "firefox-probe" };
  return { evidence: "observed", origin: event.startsWith("video-") ? "media-or-dom" : "extension" };
}

export class Telemetry {
  readonly sessionId = crypto.randomUUID();
  private sequence = 0;
  private videoCount = 0;
  private videos = new WeakMap<object, string>();
  private operations = new WeakMap<object, string>();
  private nativeEvents = new WeakSet<object>();
  constructor(private emit: (entry: LogEntry) => void) {}
  videoId(video: object) {
    let id = this.videos.get(video);
    if (!id) { id = `video-${++this.videoCount}`; this.videos.set(video, id); }
    return id;
  }
  startOperation(video: object) {
    const id = crypto.randomUUID();
    this.operations.set(video, id);
    return id;
  }
  operation(video: object) { return this.operations.get(video); }
  endOperation(video: object, id: string) {
    if (this.operations.get(video) === id) this.operations.delete(video);
  }
  firstNativeEvent(event: object) {
    if (this.nativeEvents.has(event)) return false;
    this.nativeEvents.add(event);
    return true;
  }
  record(event: string, detail = "", video?: HTMLVideoElement | null, context: Partial<LogEntry> = {}) {
    // Diagnostics must not throw into the player hooks or change their behavior.
    try {
      const sequence = ++this.sequence;
      const entry: LogEntry = {
        ts: Date.now(), event, detail, ...eventEvidence(event, detail), ...context,
        id: `${this.sessionId}:${sequence}`, sessionId: this.sessionId, sequence,
      };
      if (video) {
        entry.videoId = this.videoId(video);
        entry.operationId = context.operationId ?? this.operations.get(video);
        entry.state = { connected: video.isConnected, paused: video.paused, ended: video.ended,
          readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
          focused: document.hasFocus(), visibility: document.visibilityState };
      }
      this.emit(entry);
    } catch { /* Logging failure must not affect playback. */ }
  }
}

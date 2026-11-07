import { Telemetry } from "./telemetry";
import type { LogEntry } from "./shared";

(() => {
  const PAGE_SOURCE = "ytm-pip-keep";
  const BRIDGE_SOURCE = "ytm-pip-bridge";
  const WAIT_MS = 8000;

  type Playback = "none" | "playing" | "paused" | "dead";

  let enabled = true;
  let restorePip = false;
  let suppressLeave = false;
  let waitingForGesture = false;
  let handoffBusy = false;
  let deadSince = 0;
  let lastPlayback: Playback = "none";
  let lastGetterPresent = document.pictureInPictureElement != null;
  let ignoredLatch = false;
  let bypass = false;
  let guarded: HTMLVideoElement | null = null;
  let anchor: HTMLDivElement | null = null;
  let observer: MutationObserver | null = null;
  let handoffAfter = 0;

  const known = new Set<HTMLVideoElement>();
  const playerVideos = new Set<HTMLVideoElement>();
  const bound = new WeakSet<HTMLVideoElement>();
  const watchedRoots = new WeakSet<Node>();
  const pipWindows = new WeakSet<PictureInPictureWindow>();
  const times = new WeakMap<HTMLVideoElement, number>();
  const widths = new WeakMap<HTMLVideoElement, number>();
  const disableState = new WeakMap<HTMLVideoElement, boolean>();
  const pipHintTimes = new WeakMap<HTMLVideoElement, number>();

  const telemetry = new Telemetry((entry) => {
    window.postMessage({ source: PAGE_SOURCE, type: "log", entry }, "*");
  });

  function log(event: string, detail = "", video?: HTMLVideoElement | null, context: Partial<LogEntry> = {}) {
    telemetry.record(event, detail, video, context);
  }

  function detailOf(video: HTMLVideoElement | null, extra = "") {
    const parts = [];
    if (video instanceof HTMLVideoElement) {
      parts.push(
        `connected=${video.isConnected}`,
        `paused=${video.paused}`,
        `ended=${video.ended}`,
        `readyState=${video.readyState}`,
        `videoWidth=${video.videoWidth}`,
      );
    }
    if (extra) parts.push(extra);
    return parts.join(" ");
  }

  function isWidthZeroGlitch(video: HTMLVideoElement) {
    return (
      video.videoWidth === 0 &&
      !video.paused &&
      !video.ended &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    );
  }

  function isMediaDead(video: HTMLVideoElement | null) {
    if (!(video instanceof HTMLVideoElement)) return true;
    if (video.ended || video.readyState === HTMLMediaElement.HAVE_NOTHING) return true;
    if (video.videoWidth === 0 && !isWidthZeroGlitch(video)) return true;
    return false;
  }

  function hasDisplayFrames(video: HTMLVideoElement | null) {
    return video instanceof HTMLVideoElement && video.videoWidth > 0;
  }

  function isLive(video: HTMLVideoElement | null) {
    return (
      video instanceof HTMLVideoElement &&
      !video.paused &&
      !video.ended &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      (video.videoWidth > 0 || isWidthZeroGlitch(video))
    );
  }

  function readPlayback(video: HTMLVideoElement | null): Playback {
    if (!(video instanceof HTMLVideoElement)) return "none";
    if (isMediaDead(video)) {
      return "dead";
    }
    if (video.paused) return "paused";
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return "dead";
    const previous = times.get(video);
    times.set(video, video.currentTime);
    if (previous == null || video.currentTime > previous + 0.01 || lastPlayback === "playing") {
      return "playing";
    }
    return "playing";
  }

  function crossesShadow(node: Node, ancestor: Node) {
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      if (current.parentNode) current = current.parentNode;
      else if (current instanceof ShadowRoot) current = current.host;
      else break;
    }
    return false;
  }

  function isPlayerVideo(video: HTMLVideoElement) {
    if (anchor?.contains(video)) return false;
    if (video.classList.contains("html5-main-video") || video.classList.contains("video-stream")) {
      return true;
    }
    let current: Element | null = video;
    while (current) {
      if (current.id === "song-video" || current.id === "movie_player") return true;
      if (current.localName === "ytmusic-player" || current.localName === "ytmusic-player-page") {
        return true;
      }
      if (current.parentElement) current = current.parentElement;
      else if (current.parentNode instanceof ShadowRoot) current = current.parentNode.host;
      else {
        const root = current.getRootNode();
        current = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return false;
  }

  function shouldWatch(video: HTMLVideoElement) {
    return video === guarded || playerVideos.has(video) || isPlayerVideo(video);
  }

  function pickPrimaryPlayerVideo() {
    if (guarded instanceof HTMLVideoElement && shouldWatch(guarded)) return guarded;
    let best: HTMLVideoElement | null = null;
    let bestScore = -1;
    for (const video of known) {
      if (!isPlayerVideo(video) || (anchor && anchor.contains(video)) || !video.isConnected) continue;
      let score = video.videoWidth;
      if (video.classList.contains("html5-main-video")) score += 10_000;
      if (video.classList.contains("video-stream")) score += 5_000;
      if (score > bestScore || (score === bestScore && best && video.currentTime >= best.currentTime)) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  function shouldLogVideo(video: HTMLVideoElement) {
    if (video === guarded) return true;
    const primary = pickPrimaryPlayerVideo();
    return primary != null && video === primary;
  }

  function noteFrame(video: HTMLVideoElement) {
    if (!shouldWatch(video) || !shouldLogVideo(video)) return;
    const previous = widths.has(video) ? widths.get(video) : video.videoWidth;
    const now = video.videoWidth;
    if (widths.has(video) && (previous === 0) !== (now === 0)) {
      const label =
        now === 0 ? (isWidthZeroGlitch(video) ? "zero-transitorio" : "zero") : "quadro";
      log("video-quadro", detailOf(video, label), video);
    }
    widths.set(video, now);
  }

  function noteDisable(video: HTMLVideoElement) {
    if (!(video instanceof HTMLVideoElement) || !shouldWatch(video)) return;
    const value = video.disablePictureInPicture;
    if (disableState.get(video) === value) return;
    disableState.set(video, value);
    if (shouldLogVideo(video) && (video === guarded || isInPictureInPicture(video))) {
      log("pip-disable-flag", detailOf(video, `value=${value}`), video);
    }
    tryClaimPipFromVideo(video);
  }

  function publishPlayback() {
    if (!guarded) return;
    const state = readPlayback(guarded);
    if (state === lastPlayback) return;
    lastPlayback = state;
    if (state === "playing") log("ativo", detailOf(guarded), guarded);
    else if (state === "paused") log("pausado", detailOf(guarded), guarded);
    else if (state === "dead") {
      log("destruido", detailOf(guarded), guarded);
      deadSince = Date.now();
    }
  }

  function noteIgnored(video: HTMLVideoElement) {
    if (ignoredLatch) return;
    ignoredLatch = true;
    log("ignorado", detailOf(video, "janela-viva"), video);
  }

  function clearIgnored() {
    ignoredLatch = false;
  }

  function pipWindowOf(video: HTMLVideoElement) {
    if (typeof video.getPictureInPictureWindow === "function") {
      return video.getPictureInPictureWindow();
    }
    return null;
  }

  function isInPictureInPicture(video: HTMLVideoElement) {
    if (pipWindowOf(video)) return true;
    if (document.pictureInPictureElement === video) return true;
    try {
      return video.matches(":picture-in-picture");
    } catch {
      return false;
    }
  }

  function findVideoInPip() {
    const fromDoc = document.pictureInPictureElement;
    if (fromDoc instanceof HTMLVideoElement && fromDoc.isConnected) return fromDoc;
    for (const video of videosToProbe()) {
      if (isInPictureInPicture(video)) return video;
    }
    return null;
  }

  function videosToProbe() {
    const list = new Set<HTMLVideoElement>();
    for (const video of known) {
      if (video.isConnected) list.add(video);
    }
    document.querySelectorAll("video").forEach((node) => {
      if (node instanceof HTMLVideoElement && node.isConnected) list.add(node);
    });
    return [...list];
  }

  const hadPipWindow = new WeakMap<HTMLVideoElement, boolean>();
  const lastPipSignalKind = new WeakMap<HTMLVideoElement, string>();

  function videoHasPipSurface(video: HTMLVideoElement) {
    return Boolean(pipWindowOf(video)) || isInPictureInPicture(video);
  }

  function videoLikelyInPipLayout(video: HTMLVideoElement) {
    // No Firefox o PiP da barra mantém o <video> visível na página; layout aqui só gera falso positivo.
    if (isFirefoxBrowser()) return false;
    if (!isVideoModeActive() || video.ended) return false;
    if (mediaSessionState() !== "playing") return false;
    if (!video.isConnected) return false;
    // Vídeo ainda sem quadro / metadata: troca de faixa do YTM, não PiP.
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return false;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 20 || rect.height <= 20) return true;
    try {
      const style = getComputedStyle(video);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return true;
      }
    } catch {
      return false;
    }
    let parent: Element | null = video.parentElement;
    for (let depth = 0; parent && depth < 8; depth += 1) {
      try {
        const ps = getComputedStyle(parent);
        if (ps.display === "none" || ps.visibility === "hidden") return true;
      } catch {
        break;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  function currentPipSignal(video: HTMLVideoElement) {
    if (videoHasPipSurface(video)) return "api";
    if (videoLikelyInPipLayout(video)) return "layout";
    return null;
  }

  function logPipRadar(reason: string) {
    if (!isVideoModeActive()) return;
    const chunks: string[] = [];
    for (const video of videosToProbe()) {
      if (!isPlayerVideo(video)) continue;
      const rect = video.getBoundingClientRect();
      const sig = currentPipSignal(video) ?? "none";
      chunks.push(
        `${sig} w${video.videoWidth} ${Math.round(rect.width)}x${Math.round(rect.height)} p=${video.paused}`,
      );
    }
    log(
      "pip-radar",
      `${reason} sessao=${mediaSessionState()} getter=${document.pictureInPictureElement != null} ${chunks.join(" | ")}`,
    );
  }

  function resetPipSurfaceTracking() {
    for (const video of videosToProbe()) {
      hadPipWindow.set(video, false);
      lastPipSignalKind.set(video, "");
    }
    lastGetterPresent = document.pictureInPictureElement != null;
  }

  function pollPipWindows() {
    if (!enabled) return;
    for (const video of videosToProbe()) {
      if (!isPlayerVideo(video)) continue;
      const sig = currentPipSignal(video);
      const prev = lastPipSignalKind.get(video) ?? "";
      const next = sig ?? "";
      lastPipSignalKind.set(video, next);
      if (sig && prev === "") announcePipReopen(video, `poll-${sig}`);
      const hasApi = Boolean(sig === "api");
      const hadApi = hadPipWindow.get(video) ?? false;
      hadPipWindow.set(video, hasApi);
    }
  }

  function probeVideoOnce(video: HTMLVideoElement, source: string) {
    if (!enabled || !video.isConnected) return;
    const sig = currentPipSignal(video);
    if (!sig) return;
    const prev = lastPipSignalKind.get(video) ?? "";
    if (prev !== "") return;
    lastPipSignalKind.set(video, sig);
    if (sig === "api") hadPipWindow.set(video, true);
    announcePipReopen(video, `${source}-${sig}`);
  }

  function schedulePipAfterUiClick() {
    for (const delay of [250, 700, 1500]) {
      window.setTimeout(() => {
        if (!enabled || !isVideoModeActive()) return;
        if (lastPipUiOpen && restorePip) return;
        pollPipWindows();
        syncPipUiHint();
        const video = findVideoInPip() ?? pickPrimaryPlayerVideo();
        if (!(video instanceof HTMLVideoElement)) return;
        const sig = currentPipSignal(video);
        if (sig) {
          announcePipReopen(video, `click-${sig}`);
          return;
        }
        logPipRadar(`pos-click-${delay}`);
        // No Firefox o miniplayer do YTM não é PiP do navegador; click-assume só gera falso positivo.
        if (
          !isFirefoxBrowser() &&
          delay >= 700 &&
          mediaSessionState() === "playing" &&
          reopenAllowed()
        ) {
          announcePipReopen(video, "click-assume");
        }
      }, delay);
    }
  }

  function pipUiLabel(element: Element) {
    const label = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
    const lower = label.toLowerCase();
    if (!lower) return "";
    // "miniplayer" no YTM é o player compacto do site, não o PiP do Firefox/Chrome.
    if (lower.includes("mini player") || lower.includes("miniplayer")) return "";
    if (lower.includes("picture-in-picture") || lower.includes("picture in picture")) return label;
    if (lower.includes("pip") && lower.includes("picture")) return label;
    if (lower.includes("janela") && lower.includes("flutuante")) return label;
    if (lower.includes("imagem") && lower.includes("picture")) return label;
    return "";
  }

  function watchPipUiIntent() {
    document.addEventListener(
      "click",
      (event) => {
        if (!enabled) return;
        for (const node of event.composedPath()) {
          if (!(node instanceof Element)) continue;
          const label = pipUiLabel(node);
          if (!label) continue;
          log("pip-ui-click", label);
          kickVideoModeBurst();
          schedulePipAfterUiClick();
          return;
        }
      },
      true,
    );
  }

  function probeVideoBurst(video: HTMLVideoElement, source: string) {
    if (!(video instanceof HTMLVideoElement)) return;
    note(video);
    probeVideoOnce(video, `${source}-sync`);
    queueMicrotask(() => probeVideoOnce(video, `${source}-micro`));
    requestAnimationFrame(() => probeVideoOnce(video, `${source}-raf`));
    for (const delay of [0, 16, 50, 100, 200, 400, 800]) {
      window.setTimeout(() => probeVideoOnce(video, `${source}-t${delay}`), delay);
    }
  }

  let videoModeBurstUntil = 0;
  let videoModeBurstTimer = 0;

  function kickVideoModeBurst() {
    videoModeBurstUntil = Date.now() + 5000;
    if (videoModeBurstTimer) return;
    const tick = () => {
      if (Date.now() > videoModeBurstUntil) {
        videoModeBurstTimer = 0;
        return;
      }
      pollGetter();
      pollPipWindows();
      syncPipUiHint();
      videoModeBurstTimer = window.setTimeout(tick, 40);
    };
    tick();
  }

  function onVideoNodeInserted(node: Node, source: string) {
    if (node instanceof HTMLVideoElement) {
      probeVideoBurst(node, source);
      return;
    }
    if (!(node instanceof Element)) return;
    const videos: HTMLVideoElement[] = [];
    if (node instanceof HTMLVideoElement) videos.push(node);
    if (node.querySelectorAll) videos.push(...Array.from(node.querySelectorAll("video")));
    for (const video of videos) probeVideoBurst(video, source);
    if (node.shadowRoot) {
      watchRoot(node.shadowRoot);
      scan(node.shadowRoot);
    }
  }

  function isVideoModeActive() {
    const player = document.querySelector("ytmusic-player");
    return player instanceof Element && player.hasAttribute("video-mode");
  }

  function mediaSessionState() {
    return navigator.mediaSession?.playbackState ?? "none";
  }

  function appearsPlayingInPip(video: HTMLVideoElement) {
    if (isInPictureInPicture(video)) return true;
    const previous = pipHintTimes.get(video);
    pipHintTimes.set(video, video.currentTime);
    return (
      video.paused &&
      !video.ended &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      previous != null &&
      video.currentTime > previous + 0.04
    );
  }

  let ignoreSessionPipUntil = 0;
  let suppressSessionUiUntil = 0;
  let pipDismissed = false;
  let lastMediaSession = mediaSessionState();
  let lastPauseWhileDismissed = 0;
  let suppressReopenUntil = 0;
  let pipClosingUntil = 0;

  function reopenAllowed() {
    return Date.now() >= suppressReopenUntil;
  }

  function markPipClosing() {
    const until = Date.now() + 4000;
    suppressReopenUntil = until;
    pipClosingUntil = until;
    lastPauseWhileDismissed = 0;
  }

  function sessionOnlyOpen(video: HTMLVideoElement) {
    return (
      sessionPipSignal(video) &&
      !videoHasPipSurface(video) &&
      !videoLikelyInPipLayout(video) &&
      !appearsPlayingInPip(video)
    );
  }

  function sessionPipSignal(video: HTMLVideoElement) {
    if (!isVideoModeActive()) return false;
    if (!video.paused || video.ended) return false;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    if (!hasDisplayFrames(video) && !isWidthZeroGlitch(video)) return false;
    return mediaSessionState() === "playing";
  }

  function isSessionPlayingWhileVideoPaused(video: HTMLVideoElement) {
    if (Date.now() < ignoreSessionPipUntil) return false;
    return sessionPipSignal(video);
  }

  function isPipUiOpen(video: HTMLVideoElement) {
    const sessionOk = Date.now() >= suppressSessionUiUntil && sessionPipSignal(video);
    return isInPictureInPicture(video) || appearsPlayingInPip(video) || sessionOk;
  }

  function notePipDismissed() {
    lastPipUiOpen = false;
    pipDismissed = true;
    suppressSessionUiUntil = Date.now() + 1200;
    ignoreSessionPipUntil = Date.now() + 600;
    suppressReopenUntil = Date.now() + 2500;
    resetPipSurfaceTracking();
  }

  function releasePipSession(source: string) {
    if (!(guarded instanceof HTMLVideoElement) || !restorePip || suppressLeave) return;
    log("pip-leave", detailOf(guarded, source), guarded);
    restorePip = false;
    waitingForGesture = false;
    deadSince = 0;
    clearIgnored();
    log("desativado", detailOf(guarded, source), guarded);
    lastPlayback = "none";
    guarded = null;
    releaseAnchor();
  }

  function tryClaimPipFromVideo(video: HTMLVideoElement, opts?: { trustSession?: boolean }) {
    if (!enabled || !shouldWatch(video)) return;
    const pipWindow = pipWindowOf(video);
    const inPip = isInPictureInPicture(video);
    const pipPlayback = appearsPlayingInPip(video);
    const sessionPip = opts?.trustSession
      ? sessionPipSignal(video)
      : isSessionPlayingWhileVideoPaused(video);
    if (!inPip && !pipPlayback && !sessionPip) return;
    const source = pipWindow
      ? "janela"
      : sessionPip
        ? "sessao"
        : pipPlayback && !inPip
          ? "tocando-pausado"
          : "pseudo";
    if (guarded !== video || !restorePip) {
      claimPipSession(video, source, pipWindow);
      return;
    }
    if (pipWindow && !pipWindows.has(pipWindow)) {
      pipWindows.add(pipWindow);
      pipWindow.addEventListener("resize", () => {
        log("pip-resize", detailOf(video, `${pipWindow.width}x${pipWindow.height}`), video);
      });
    }
  }

  function claimPipSession(video: HTMLVideoElement, source: string, pipWindow?: PictureInPictureWindow | null) {
    const fresh = guarded !== video || !restorePip;
    note(video);
    guarded = video;
    restorePip = true;
    waitingForGesture = false;
    deadSince = 0;
    clearIgnored();
    lastPlayback = "none";
    if (fresh) {
      log("pip-enter", detailOf(video, source), video, { origin: source });
      log("detectado", detailOf(video, source), video, { origin: source });
    }
    publishPlayback();
    if (pipWindow && !pipWindows.has(pipWindow)) {
      pipWindows.add(pipWindow);
      pipWindow.addEventListener("resize", () => {
        log("pip-resize", detailOf(video, `${pipWindow.width}x${pipWindow.height}`), video);
      });
    }
  }

  let lastPipUiOpen = false;

  /**
   * Firefox chrome PiP não dispara enterpictureinpicture.
   * O setupPlayer chama notifyUserGestureActivation(): isso renova
   * navigator.userActivation.isActive (TTL ~5s) sem clique na página.
   * Se isActive continua true depois do TTL do último gesto da página, o PiP abriu.
   */
  let firefoxPip = false;
  let firefoxPageGestureAt = 0;
  let firefoxHadFocus = typeof document !== "undefined" && document.hasFocus();
  let firefoxVisibility: DocumentVisibilityState =
    typeof document !== "undefined" ? document.visibilityState : "visible";
  let firefoxLastActivation = false;
  let firefoxPollTimer = 0;
  let firefoxSuppressArmUntil = 0;
  let firefoxLastBlurAt = 0;
  const firefoxOpenTimers = new Set<number>();

  const FIREFOX_GESTURE_QUIET_MS = 200;
  const FIREFOX_ACTIVATION_TTL_MS = 5200;
  // Precisa cobrir o TTL de userActivation (~5s) pra não rearmar com ativacao-viva.
  const FIREFOX_REARM_COOLDOWN_MS = 5500;
  const FIREFOX_BLUR_DEBOUNCE_MS = 400;

  function isFirefoxBrowser() {
    return /Firefox\//.test(navigator.userAgent);
  }

  function noteFirefoxPageGesture(event: Event) {
    if (!event.isTrusted) return;
    if (event instanceof KeyboardEvent) {
      if (event.repeat) return;
      if (/^(Control|Shift|Alt|Meta|Escape|Arrow|Tab|CapsLock|F\d+$)/.test(event.key)) return;
    }
    firefoxPageGestureAt = Date.now();
  }

  function firefoxPageQuiet() {
    return Date.now() - firefoxPageGestureAt > FIREFOX_GESTURE_QUIET_MS;
  }

  function firefoxGestureStale() {
    return firefoxPageGestureAt === 0 || Date.now() - firefoxPageGestureAt > FIREFOX_ACTIVATION_TTL_MS;
  }

  function firefoxActivationOn() {
    return navigator.userActivation?.isActive === true;
  }

  function firefoxCloneOn(video: HTMLVideoElement) {
    try {
      return video.isCloningElementVisually === true;
    } catch {
      return false;
    }
  }

  function firefoxPlaying(video: HTMLVideoElement) {
    if (video.ended) return false;
    if (!video.paused) return isVideoModeActive() || isPlayerVideo(video);
    return mediaSessionState() === "playing" && (isVideoModeActive() || isPlayerVideo(video));
  }

  function clearFirefoxOpenTimers() {
    for (const id of firefoxOpenTimers) window.clearTimeout(id);
    firefoxOpenTimers.clear();
  }

  function armFirefoxPip(video: HTMLVideoElement, source: string) {
    if (!enabled) return;
    if (document.pictureInPictureElement) return;
    if (Date.now() < firefoxSuppressArmUntil) return;
    if (firefoxPip && restorePip && lastPipUiOpen) return;
    firefoxPip = true;
    clearFirefoxOpenTimers();
    log(
      "pip-firefox",
      `abre ${source} foco=${document.hasFocus()} vis=${document.visibilityState} ativ=${firefoxActivationOn()} gesto=${Date.now() - firefoxPageGestureAt}ms`,
      video, { origin: `firefox-${source}`, ...(source === "clone" ? { evidence: "observed", outcome: "confirmed" } : {}) },
    );
    announcePipReopen(video, `firefox-${source}`);
  }

  function disarmFirefoxPip(source: string) {
    if (!firefoxPip || suppressLeave || handoffBusy) return;
    firefoxPip = false;
    firefoxSuppressArmUntil = Date.now() + FIREFOX_REARM_COOLDOWN_MS;
    clearFirefoxOpenTimers();
    const video = guarded instanceof HTMLVideoElement ? guarded : pickPrimaryPlayerVideo();
    log("pip-firefox", `fecha ${source}`, video, { origin: `firefox-${source}` });
    markPipClosing();
    if (lastPipUiOpen || restorePip) {
      if (video instanceof HTMLVideoElement) log("pip-fecha", detailOf(video, source), video);
      releasePipSession(source);
    }
    notePipDismissed();
  }

  function firefoxSurfaceLooksOpen() {
    return document.visibilityState === "visible" && !document.hasFocus();
  }

  function tryArmFirefox(source: string) {
    if (!enabled || firefoxPip || document.pictureInPictureElement) return false;
    if (Date.now() < firefoxSuppressArmUntil) return false;
    const video = pickPrimaryPlayerVideo();
    if (!(video instanceof HTMLVideoElement) || !firefoxPlaying(video)) return false;
    armFirefoxPip(video, source);
    return true;
  }

  function scheduleFirefoxOpenFromBlur() {
    if (!isFirefoxBrowser() || !enabled || firefoxPip) return;
    if (Date.now() < firefoxSuppressArmUntil) return;
    const now = Date.now();
    if (now - firefoxLastBlurAt < FIREFOX_BLUR_DEBOUNCE_MS) return;
    firefoxLastBlurAt = now;
    const gestureAt = firefoxPageGestureAt;
    clearFirefoxOpenTimers();
    log("pip-firefox-probe", `blur ativ=${firefoxActivationOn()} quiet=${firefoxPageQuiet()} stale=${firefoxGestureStale()}`);
    // Chrome PiP renova ativação sem gesto da página. Alt-tab após play NÃO.
    if (firefoxActivationOn() && firefoxGestureStale()) tryArmFirefox("blur");
    for (const delay of [80, 250, 700]) {
      const id = window.setTimeout(() => {
        firefoxOpenTimers.delete(id);
        if (!enabled || firefoxPip || document.pictureInPictureElement) return;
        if (Date.now() < firefoxSuppressArmUntil) return;
        if (!firefoxSurfaceLooksOpen()) return;
        if (firefoxPageGestureAt !== gestureAt && !firefoxPageQuiet()) return;
        if (!firefoxActivationOn() || !firefoxGestureStale()) return;
        tryArmFirefox("foco");
      }, delay);
      firefoxOpenTimers.add(id);
    }
  }

  function noteFirefoxPause(video: HTMLVideoElement) {
    if (!firefoxPip || video !== guarded) return;
    // Pause, blur e foco também ocorrem com a janela aberta e na troca de faixa.
    // Sem um evento de saída, mantenha a sessão protegida.
    log("pip-firefox-probe", `pausa-preservada ${detailOf(video)} foco=${document.hasFocus()}`, video);
  }

  function onFirefoxFocusChange() {
    if (!isFirefoxBrowser() || !enabled) return;
    const focused = document.hasFocus();
    const visibility = document.visibilityState;
    if (firefoxHadFocus && !focused && visibility === "visible") {
      scheduleFirefoxOpenFromBlur();
    }
    firefoxHadFocus = focused;
    firefoxVisibility = visibility;
  }

  function watchFirefoxPip() {
    if (!isFirefoxBrowser() || !enabled) return;

    const activation = firefoxActivationOn();
    const activationRose = activation && !firefoxLastActivation;
    firefoxLastActivation = activation;

    const video = pickPrimaryPlayerVideo();
    if (video instanceof HTMLVideoElement && firefoxCloneOn(video)) {
      armFirefoxPip(video, "clone");
      return;
    }

    // ativacao-viva só com superfície perdida (PiP chrome). Tab focada + play ≠ PiP.
    if (
      activation &&
      firefoxGestureStale() &&
      firefoxSurfaceLooksOpen() &&
      video instanceof HTMLVideoElement &&
      firefoxPlaying(video)
    ) {
      tryArmFirefox("ativacao-viva");
    }

    if (activationRose && firefoxPageQuiet() && firefoxGestureStale()) {
      tryArmFirefox(firefoxSurfaceLooksOpen() ? "ativacao-foco" : "ativacao");
    }

  }

  function bootFirefoxPipWatcher() {
    if (!isFirefoxBrowser()) return;
    firefoxLastActivation = firefoxActivationOn();
    document.addEventListener("pointerdown", noteFirefoxPageGesture, true);
    document.addEventListener("keydown", noteFirefoxPageGesture, true);
    document.addEventListener("touchend", noteFirefoxPageGesture, true);
    window.addEventListener("blur", onFirefoxFocusChange, true);
    window.addEventListener("focus", onFirefoxFocusChange, true);
    document.addEventListener("visibilitychange", onFirefoxFocusChange, true);
    document.addEventListener(
      "MozTogglePictureInPicture",
      (event) => {
        const video =
          event.target instanceof HTMLVideoElement ? event.target : pickPrimaryPlayerVideo();
        if (video instanceof HTMLVideoElement) {
          if (telemetry.firstNativeEvent(event)) log("pip-native-toggle", "MozTogglePictureInPicture: solicitação recebida", video, { evidence: "attempt", outcome: "unconfirmed", origin: event.isTrusted ? "browser-event" : "synthetic-event" });
          armFirefoxPip(video, "moz");
        }
      },
      true,
    );
    document.addEventListener(
      "MozStopPictureInPicture",
      (event) => {
        if (telemetry.firstNativeEvent(event)) log("pip-native-leave", "MozStopPictureInPicture", guarded, { outcome: event.isTrusted ? "confirmed" : "unconfirmed", origin: event.isTrusted ? "browser-event" : "synthetic-event" });
        disarmFirefoxPip("moz");
      },
      true,
    );
    firefoxPollTimer = window.setInterval(watchFirefoxPip, 100);
    log("extensao-firefox", "PiP da barra por ativacao-viva (~5s)");
  }

  function announcePipReopen(video: HTMLVideoElement, source: string) {
    if (guarded === video && restorePip && lastPipUiOpen) return;
    if (!reopenAllowed()) {
      const strong =
        source.startsWith("enter") ||
        source.startsWith("firefox-") ||
        source.startsWith("click-") ||
        source.includes("poll-api") ||
        source.includes("getter") ||
        currentPipSignal(video) === "api";
      if (!strong) return;
    }
    const wasDismissed = pipDismissed || !restorePip;
    pipDismissed = false;
    suppressSessionUiUntil = 0;
    ignoreSessionPipUntil = 0;
    suppressReopenUntil = 0;
    pipClosingUntil = 0;
    lastPipUiOpen = true;
    lastMediaSession = mediaSessionState();
    const tag = wasDismissed ? "reabre" : "abre";
    log("pip-abre", detailOf(video, `${tag} ${source} sessao=${lastMediaSession}`), video, { origin: source,
      ...(source === "getter" || source.endsWith("-api") ? { evidence: "observed", outcome: "confirmed" } : {}) });
    note(video);
    claimPipSession(video, source, pipWindowOf(video));
  }

  function syncPipUiHint() {
    if (!enabled) return;
    const primary = pickPrimaryPlayerVideo();
    if (!(primary instanceof HTMLVideoElement)) return;
    const pipVideo = findVideoInPip();
    const subject = pipVideo ?? primary;
    const session = mediaSessionState();
    const sessionBecamePlaying =
      pipDismissed &&
      !restorePip &&
      session === "playing" &&
      lastMediaSession !== "playing" &&
      sessionPipSignal(subject);
    const pipJustAppeared = pipVideo != null && !lastPipUiOpen;
    const open = isPipUiOpen(subject) || pipVideo != null || firefoxPip;
    const uiReopen = open && !lastPipUiOpen && !sessionOnlyOpen(subject) && !firefoxPip;
    const reopen =
      reopenAllowed() &&
      (pipJustAppeared || sessionBecamePlaying || uiReopen);
    const close = !open && lastPipUiOpen && !firefoxPip;

    if (reopen) {
      const source = pipJustAppeared
        ? "api"
        : sessionBecamePlaying
          ? "sessao-edge"
          : "ui";
      announcePipReopen(subject, source);
      lastMediaSession = session;
      return;
    }
    if (close) {
      markPipClosing();
      lastPipUiOpen = false;
      notePipDismissed();
      log("pip-fecha", detailOf(subject, `sessao=${session}`), subject);
      releasePipSession("sessao");
      lastMediaSession = session;
      return;
    }
    if (
      open &&
      (restorePip || isInPictureInPicture(subject) || appearsPlayingInPip(subject))
    ) {
      tryClaimPipFromVideo(subject);
    }
    lastMediaSession = session;
  }

  function onEnter(event: PictureInPictureEvent) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (telemetry.firstNativeEvent(event)) log("pip-native-enter", "enterpictureinpicture", video, { outcome: event.isTrusted ? "confirmed" : "unconfirmed", origin: event.isTrusted ? "browser-event" : "synthetic-event" });
    note(video);
    hadPipWindow.set(video, true);
    announcePipReopen(video, "enter");
  }

  function onLeave(event: PictureInPictureEvent) {
    const recordEvent = telemetry.firstNativeEvent(event);
    const video = event.target instanceof HTMLVideoElement ? event.target : guarded;
    if (recordEvent) log("pip-native-leave", "leavepictureinpicture", video, { outcome: event.isTrusted ? "confirmed" : "unconfirmed", origin: event.isTrusted ? "browser-event" : "synthetic-event" });
    if (video instanceof HTMLVideoElement) hadPipWindow.set(video, false);
    firefoxPip = false;
    markPipClosing();
    notePipDismissed();
    lastMediaSession = mediaSessionState();
    if (recordEvent) log("pip-fecha", detailOf(video, "leave"), video, { origin: event.isTrusted ? "browser-event" : "synthetic-event", evidence: "observed", outcome: event.isTrusted ? "confirmed" : "unconfirmed" });
    if (recordEvent) log("pip-leave", detailOf(video), video);
    if (suppressLeave) return;
    restorePip = false;
    waitingForGesture = false;
    deadSince = 0;
    clearIgnored();
    if (recordEvent) log("desativado", detailOf(video), video);
    lastPlayback = "none";
    if (guarded === video) guarded = null;
    releaseAnchor();
  }

  function bind(video: HTMLVideoElement) {
    if (bound.has(video)) return;
    bound.add(video);
    video.addEventListener("enterpictureinpicture", onEnter, true);
    video.addEventListener("leavepictureinpicture", onLeave, true);
    video.addEventListener("resize", () => noteFrame(video));

    const media = [
      ["emptied", "video-emptied"],
      ["abort", "video-abort"],
      ["error", "video-error"],
      ["ended", "video-ended"],
      ["loadstart", "video-loadstart"],
      ["loadedmetadata", "video-loadedmetadata"],
      ["loadeddata", "video-loadeddata"],
      ["play", "video-play"],
      ["pause", "video-pause"],
      ["playing", "video-playing"],
      ["waiting", "video-waiting"],
      ["stalled", "video-stalled"],
      ["suspend", "video-suspend"],
    ];
    for (const [name, eventName] of media) {
      video.addEventListener(name, () => {
        if (!shouldWatch(video)) return;
        const extra = name === "error" && video.error ? `code=${video.error.code}` : "";
        if (shouldLogVideo(video)) log(eventName, detailOf(video, extra), video);
        noteFrame(video);
        if (video === guarded) publishPlayback();
        if (name === "playing" || name === "loadeddata") considerHandoff();
        if (name === "pause") {
          if (firefoxPip) noteFirefoxPause(video);
          else if (isVideoModeActive()) {
            if (lastPipUiOpen || restorePip) markPipClosing();
            else if (pipDismissed && !restorePip) lastPauseWhileDismissed = Date.now();
          }
        }
        if (name === "playing" || name === "pause") syncPipUiHint();
      });
    }
  }

  function note(video: HTMLVideoElement) {
    if (!(video instanceof HTMLVideoElement)) return;
    const fresh = !known.has(video);
    if (fresh) {
      known.add(video);
      bind(video);
      if (shouldLogVideo(video)) log("video-criado", detailOf(video), video);
      noteFrame(video);
      noteDisable(video);
    }
    if (isPlayerVideo(video)) playerVideos.add(video);
    if (fresh) probeVideoOnce(video, "note-sync");
  }

  function scan(root: ParentNode) {
    if (!root) return;
    const videos = [];
    if (root instanceof HTMLVideoElement) videos.push(root);
    if (root.querySelectorAll) videos.push(...Array.from(root.querySelectorAll("video")));
    for (const video of videos) {
      const fresh = !known.has(video);
      note(video);
      if (isPlayerVideo(video)) playerVideos.add(video);
      if (
        fresh &&
        video.isConnected &&
        !(anchor && anchor.contains(video)) &&
        shouldWatch(video) &&
        shouldLogVideo(video)
      ) {
        log("video-inserido", detailOf(video), video);
      }
      if (fresh && video.isConnected) probeVideoBurst(video, "scan");
    }
    const elements = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
    for (const element of elements) {
      if (element.shadowRoot) {
        watchRoot(element.shadowRoot);
        scan(element.shadowRoot);
      }
    }
  }

  function watchRoot(root: Node) {
    if (!root || watchedRoots.has(root) || !observer) return;
    watchedRoots.add(root);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["video-mode", "disablepictureinpicture", "class", "hidden", "aria-hidden"],
    });
  }

  function onMutations(records: MutationRecord[]) {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) {
        if (record.attributeName === "video-mode" && record.target.localName === "ytmusic-player") {
          const on = record.target.hasAttribute("video-mode");
          log("modo-video", on ? "on" : "off");
          if (on) {
            kickVideoModeBurst();
            window.setTimeout(() => logPipRadar("modo-video"), 400);
          }
        }
        if (record.attributeName === "disablepictureinpicture" && record.target instanceof HTMLVideoElement) {
          noteDisable(record.target);
        }
        if (record.attributeName === "class" && record.target instanceof Element) {
          const id = record.target.id;
          const tag = record.target.localName;
          if (id === "movie_player" || tag === "ytmusic-player" || record.target.classList.contains("html5-video-player")) {
            const cls = record.target.className?.toString() ?? "";
            if (/pip|picture-in-picture/i.test(cls)) {
              log("pip-classe", cls.slice(0, 120));
              const video = pickPrimaryPlayerVideo();
              if (video instanceof HTMLVideoElement) announcePipReopen(video, "classe");
            }
          }
        }
        continue;
      }
      if (record.type !== "childList") continue;
      for (const node of Array.from(record.addedNodes)) visitAdded(node);
      for (const node of Array.from(record.removedNodes)) visitRemoved(node);
    }
  }

  function visitAdded(node: Node) {
    if (!(node instanceof Element)) return;
    const videos = [];
    if (node instanceof HTMLVideoElement) videos.push(node);
    if (node.querySelectorAll) videos.push(...Array.from(node.querySelectorAll("video")));
    for (const video of videos) {
      const fresh = !known.has(video);
      note(video);
      if (isPlayerVideo(video)) playerVideos.add(video);
      if (!(anchor && anchor.contains(video)) && shouldWatch(video) && shouldLogVideo(video) && !bypass) {
        log("video-inserido", detailOf(video), video);
      }
      if (fresh && video.isConnected) probeVideoBurst(video, "mutation");
    }
    if (isVideoModeActive()) kickVideoModeBurst();
    if (node.shadowRoot) {
      watchRoot(node.shadowRoot);
      scan(node.shadowRoot);
    }
    if (node.querySelectorAll) {
      for (const element of Array.from(node.querySelectorAll("*"))) {
        if (element.shadowRoot) {
          watchRoot(element.shadowRoot);
          scan(element.shadowRoot);
        }
      }
    }
  }

  function visitRemoved(node: Node) {
    if (bypass) return;
    if (node instanceof HTMLVideoElement) {
      if (shouldWatch(node) && !node.isConnected) {
        if (shouldLogVideo(node)) log("video-desconectou", detailOf(node), node);
        adoptDetached(node);
      }
      return;
    }
    if (!(node instanceof Element) || !node.querySelectorAll) return;
    for (const video of Array.from(node.querySelectorAll("video"))) {
      if (shouldWatch(video) && !video.isConnected) {
        if (shouldLogVideo(video)) log("video-desconectou", detailOf(video), video);
        adoptDetached(video);
      }
    }
  }

  function adoptDetached(video: HTMLVideoElement) {
    if (!isLive(video)) return;
    if (guarded && guarded !== video && (isLive(guarded) || readPlayback(guarded) === "paused")) return;
    if (guarded === video && restorePip) {
      noteIgnored(video);
      return;
    }
    guarded = video;
    restorePip = true;
    deadSince = 0;
    lastPlayback = "none";
    log("detectado", detailOf(video, "solto"), video);
    noteIgnored(video);
    publishPlayback();
  }

  function ensureAnchor() {
    if (anchor && anchor.isConnected) return anchor;
    const root = document.documentElement;
    if (!root) return null;
    anchor = document.createElement("div");
    anchor.id = "ytm-pip-anchor";
    anchor.setAttribute(
      "style",
      "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;",
    );
    root.appendChild(anchor);
    return anchor;
  }

  function park(video: HTMLVideoElement) {
    const host = ensureAnchor();
    if (!host || video.parentNode === host) return;
    bypass = true;
    try {
      host.appendChild(video);
    } finally {
      bypass = false;
    }
  }

  function shouldPreserveGuardedOnRemoval() {
    return enabled && restorePip && guarded instanceof HTMLVideoElement && !guarded.ended;
  }

  function parkGuardedForRemoval(api: string) {
    if (!(guarded instanceof HTMLVideoElement)) return;
    suppressLeave = true;
    try {
      logRemoval(api, true);
      park(guarded);
    } finally {
      window.setTimeout(() => {
        suppressLeave = false;
        considerHandoff();
      }, 0);
    }
  }

  function releaseAnchor() {
    if (!anchor) return;
    const videos = Array.from(anchor.querySelectorAll("video"));
    bypass = true;
    try {
      for (const video of videos) video.remove();
    } finally {
      bypass = false;
    }
  }

  function removalTouchesGuarded(node: Node) {
    if (bypass || !(guarded instanceof HTMLVideoElement) || !shouldPreserveGuardedOnRemoval()) return false;
    if (node === guarded) return true;
    return node instanceof Element && (node.contains(guarded) || crossesShadow(guarded, node));
  }

  function logRemoval(api: string, parked: boolean) {
    log("video-removido", detailOf(guarded, parked ? `${api} estacionado` : api), guarded);
  }

  function logForeignRemoval(node: Node, api: string) {
    if (!enabled || bypass) return;
    const videos = [];
    if (node instanceof HTMLVideoElement) videos.push(node);
    else if (node instanceof Element && node.querySelectorAll) videos.push(...Array.from(node.querySelectorAll("video")));
    for (const video of videos) {
      if (!shouldWatch(video) || video === guarded || !shouldLogVideo(video)) continue;
      log("video-removido", detailOf(video, api), video);
    }
  }

  function dropIfStillChild(parent: Node, child: Node, original: (this: Node, child: Node) => Node) {
    if (child.parentNode === parent) return original.call(parent, child);
    return child;
  }

  function findCandidate() {
    let candidate = null;
    for (const video of known) {
      if (video === guarded) continue;
      if (anchor && anchor.contains(video)) continue;
      if (!isPlayerVideo(video) && !playerVideos.has(video)) continue;
      if (anchor && anchor.contains(video)) continue;
      if (
        !hasDisplayFrames(video) ||
        video.paused ||
        video.ended ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        continue;
      }
      candidate = video;
    }
    return candidate;
  }

  function guardedNeedsSwap() {
    if (!(guarded instanceof HTMLVideoElement)) return restorePip;
    const parked = Boolean(anchor && anchor.contains(guarded));
    const detached = !guarded.isConnected;
    const dead = isMediaDead(guarded);
    return dead || parked || detached;
  }

  async function handoff(candidate: HTMLVideoElement) {
    if (!enabled || !restorePip || handoffBusy || !(candidate instanceof HTMLVideoElement)) return;
    handoffBusy = true;
    suppressLeave = true;
    const previous = guarded;
    const operationId = telemetry.startOperation(candidate);
    log("pip-handoff-start", previous ? `anterior=${telemetry.videoId(previous)}` : "sem-video-anterior", candidate);
    try {
      if (candidate.disablePictureInPicture) candidate.disablePictureInPicture = false;
      if (previous && previous !== candidate) {
        previous.muted = true;
        previous.pause();
      }
      await candidate.requestPictureInPicture();
      guarded = candidate;
      playerVideos.add(candidate);
      restorePip = true;
      waitingForGesture = false;
      deadSince = 0;
      clearIgnored();
      lastPlayback = "none";
      log("handoff", detailOf(candidate), candidate);
      publishPlayback();
      if (previous && previous !== candidate && anchor && anchor.contains(previous)) {
        bypass = true;
        try {
          previous.remove();
        } finally {
          bypass = false;
        }
      }
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "Error";
      log("erro", detailOf(candidate, name), candidate);
      if (name === "NotAllowedError") waitingForGesture = true;
      else {
        handoffAfter = Date.now() + 1000;
        if (name === "InvalidStateError") waitForFrames(candidate);
      }
    } finally {
      telemetry.endOperation(candidate, operationId);
      suppressLeave = false;
      handoffBusy = false;
    }
  }

  function waitForFrames(video: HTMLVideoElement) {
    const started = Date.now();
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("resize", onReady);
      video.removeEventListener("playing", onReady);
      if (timedOut) log("erro", detailOf(video, "espera-encerrada"), video);
    };
    const onReady = () => {
      if (!enabled || !restorePip) {
        finish(false);
        return;
      }
      if (Date.now() - started > WAIT_MS) {
        finish(true);
        return;
      }
      const player = document.querySelector("ytmusic-player");
      const songMode = player instanceof Element && !player.hasAttribute("video-mode") && video.videoWidth === 0;
      if (songMode && !isLive(video)) {
        finish(false);
        return;
      }
      if (isLive(video)) {
        finish(false);
        handoff(video);
      }
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("resize", onReady);
    video.addEventListener("playing", onReady);
    window.setTimeout(onReady, WAIT_MS);
  }

  function considerHandoff() {
    if (!enabled || !restorePip || handoffBusy || waitingForGesture || Date.now() < handoffAfter) return;
    if (deadSince && Date.now() - deadSince > WAIT_MS && !findCandidate()) {
      deadSince = 0;
      return;
    }
    const candidate = findCandidate();
    if (!candidate) {
      if (
        guarded &&
        (isLive(guarded) || (guarded.paused && guarded.videoWidth > 0 && guarded.readyState > 0)) &&
        (!guarded.isConnected || (anchor && anchor.contains(guarded)))
      ) {
        noteIgnored(guarded);
      }
      return;
    }
    clearIgnored();
    if (!guardedNeedsSwap()) return;
    handoff(candidate);
  }

  function hookInsertionApis() {
    const originalAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, child: T): T {
      const result = originalAppendChild.call(this, child) as T;
      onVideoNodeInserted(child, "appendChild");
      return result;
    } as typeof Node.prototype.appendChild;

    const originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function insertBefore<T extends Node>(this: Node, node: T, child: Node | null): T {
      const result = originalInsertBefore.call(this, node, child) as T;
      onVideoNodeInserted(node, "insertBefore");
      return result;
    } as typeof Node.prototype.insertBefore;

    const originalCloneNode = Node.prototype.cloneNode;
    Node.prototype.cloneNode = function cloneNode(deep?: boolean) {
      const clone = originalCloneNode.call(this, deep);
      if (clone instanceof HTMLVideoElement) probeVideoBurst(clone, "cloneNode");
      else if (deep && clone instanceof Element) onVideoNodeInserted(clone, "cloneNode-deep");
      return clone;
    };
  }

  function hookRemovalApis() {
    const originalRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function removeChild(this: Node, child: Node) {
      if (removalTouchesGuarded(child)) {
        parkGuardedForRemoval("removeChild");
        return dropIfStillChild(this, child, originalRemoveChild);
      }
      logForeignRemoval(child, "removeChild");
      return originalRemoveChild.call(this, child);
    } as typeof Node.prototype.removeChild;

    const originalReplaceChild = Node.prototype.replaceChild;
    Node.prototype.replaceChild = function replaceChild(this: Node, newChild: Node, oldChild: Node) {
      if (removalTouchesGuarded(oldChild)) {
        const next = oldChild.nextSibling;
        parkGuardedForRemoval("replaceChild");
        if (oldChild.parentNode !== this) {
          bypass = true;
          try {
            if (next && next.parentNode === this) this.insertBefore(newChild, next);
            else this.appendChild(newChild);
          } finally {
            bypass = false;
          }
          return oldChild;
        }
      } else {
        logForeignRemoval(oldChild, "replaceChild");
      }
      const replaced = originalReplaceChild.call(this, newChild, oldChild);
      onVideoNodeInserted(newChild, "replaceChild");
      return replaced;
    } as typeof Node.prototype.replaceChild;

    const originalRemove = Element.prototype.remove;
    Element.prototype.remove = function remove() {
      if (removalTouchesGuarded(this)) {
        const parent = this.parentNode;
        parkGuardedForRemoval("remove");
        if (this.parentNode && parent) return originalRemove.call(this);
        return;
      }
      logForeignRemoval(this, "remove");
      return originalRemove.call(this);
    };

    const originalReplaceWith = Element.prototype.replaceWith;
    Element.prototype.replaceWith = function replaceWith(...nodes) {
      if (removalTouchesGuarded(this)) {
        const parent = this.parentNode;
        const next = this.nextSibling;
        parkGuardedForRemoval("replaceWith");
        if (this.parentNode && parent) return originalReplaceWith.apply(this, nodes);
        if (parent) {
          bypass = true;
          try {
            const fragment = document.createDocumentFragment();
            for (const node of nodes) fragment.append(node);
            if (next && next.parentNode === parent) parent.insertBefore(fragment, next);
            else parent.append(fragment);
          } finally {
            bypass = false;
          }
        }
        return;
      }
      logForeignRemoval(this, "replaceWith");
      return originalReplaceWith.apply(this, nodes);
    };

    const originalReplaceChildren = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function replaceChildren(...nodes) {
      if (removalTouchesGuarded(this)) {
        parkGuardedForRemoval("replaceChildren");
      } else if (guarded && this instanceof Element && crossesShadow(guarded, this)) {
        logRemoval("replaceChildren", false);
      }
      const result = originalReplaceChildren.apply(this, nodes);
      for (const node of nodes) {
        if (node instanceof Node) onVideoNodeInserted(node, "replaceChildren");
      }
      return result;
    };

    const inner = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (inner?.set && inner.get) {
      const setInner = inner.set;
      Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: true,
        enumerable: inner.enumerable,
        get: inner.get,
        set(value: string) {
          if (removalTouchesGuarded(this)) {
            parkGuardedForRemoval("innerHTML");
          } else if (guarded && crossesShadow(guarded, this)) {
            logRemoval("innerHTML", false);
          }
          setInner.call(this, value);
        },
      });
    }
  }

  function hookMediaApis() {
    const originalCreate = Document.prototype.createElement;
    Document.prototype.createElement = function createElement(this: Document, tagName: string, options?: ElementCreationOptions) {
      const element = originalCreate.call(this, tagName, options);
      if (typeof tagName === "string" && tagName.toLowerCase() === "video" && element instanceof HTMLVideoElement) {
        probeVideoBurst(element, "createElement");
      }
      return element;
    };

    const originalCreateNS = Document.prototype.createElementNS;
    Document.prototype.createElementNS = function createElementNS(
      this: Document,
      namespace: string | null,
      qualifiedName: string,
      options?: ElementCreationOptions,
    ) {
      const element = originalCreateNS.call(this, namespace, qualifiedName, options);
      if (qualifiedName.toLowerCase() === "video" && element instanceof HTMLVideoElement) {
        probeVideoBurst(element, "createElementNS");
      }
      return element;
    } as typeof Document.prototype.createElementNS;

    const originalAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachShadow(init) {
      const shadow = originalAttach.call(this, init);
      watchRoot(shadow);
      return shadow;
    };

    const originalRequest = HTMLVideoElement.prototype.requestPictureInPicture;
    HTMLVideoElement.prototype.requestPictureInPicture = function requestPictureInPicture() {
      const video = this instanceof HTMLVideoElement ? this : null;
      const tracked = Boolean(video && (isPlayerVideo(video) || known.has(video)));
      const operationId = video ? (handoffBusy ? telemetry.operation(video) : telemetry.startOperation(video)) : undefined;
      if (video) note(video);
      if (tracked && video && shouldLogVideo(video)) log("pip-request", detailOf(video), video);
      try {
        const pending = originalRequest.call(this);
        if (video) {
          probeVideoBurst(video, "request");
          Promise.resolve(pending).then(
            () => {
              if (tracked && shouldLogVideo(video)) log("pip-request-ok", detailOf(video), video, { operationId });
              probeVideoOnce(video, "request-ok");
              if (!handoffBusy && operationId) telemetry.endOperation(video, operationId);
            },
            (error: unknown) => {
              if (!handoffBusy && operationId) telemetry.endOperation(video, operationId);
              if (tracked && shouldLogVideo(video)) {
                log("pip-request-erro", detailOf(video, error instanceof DOMException ? error.name : ""), video, { operationId });
              }
            },
          );
        }
        return pending;
      } catch (error: unknown) {
        if (video && !handoffBusy && operationId) telemetry.endOperation(video, operationId);
        if (tracked && video && shouldLogVideo(video)) {
          log("pip-request-erro", detailOf(video, error instanceof DOMException ? error.name : ""), video, { operationId });
        }
        throw error;
      }
    };

    if (typeof Document.prototype.exitPictureInPicture === "function") {
      const originalExit = Document.prototype.exitPictureInPicture;
      Document.prototype.exitPictureInPicture = function exitPictureInPicture() {
        log("pip-exit-chamado", "");
        return originalExit.call(this);
      };
    }

    hookProp(HTMLMediaElement.prototype, "src", "src");
    hookProp(HTMLMediaElement.prototype, "srcObject", "srcObject");

    const originalLoad = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function load() {
      if (this instanceof HTMLVideoElement && shouldWatch(this) && shouldLogVideo(this)) {
        log("video-load", detailOf(this), this);
      }
      return originalLoad.call(this);
    };

    const disable = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "disablePictureInPicture");
    if (disable?.set && disable.get) {
      const setDisable = disable.set;
      Object.defineProperty(HTMLVideoElement.prototype, "disablePictureInPicture", {
        configurable: true,
        enumerable: disable.enumerable,
        get: disable.get,
        set(value: boolean) {
          setDisable.call(this, value);
          noteDisable(this);
        },
      });
    }

    const session = window.navigator.mediaSession;
    if (session && typeof MediaSession.prototype.setActionHandler === "function") {
      const originalSetAction = MediaSession.prototype.setActionHandler;
      MediaSession.prototype.setActionHandler = function setActionHandler(type, handler) {
        if ((type as string) !== "enterpictureinpicture" || typeof handler !== "function") {
          return originalSetAction.call(this, type, handler);
        }
        return originalSetAction.call(this, type, (details) => {
          log("pip-sessao-enter", "");
          let result: unknown;
          try {
            result = handler.call(this, details);
          } catch (error) {
            throw error;
          }
          const afterHandler = () => {
            const candidate = findVideoInPip();
            const primary = pickPrimaryPlayerVideo();
            const video =
              candidate ??
              (primary instanceof HTMLVideoElement ? primary : null);
            if (video instanceof HTMLVideoElement) announcePipReopen(video, "sessao-handler");
          };
          Promise.resolve(result).then(afterHandler).catch(afterHandler);
          return result;
        });
      };
    }
  }

  function hookProp(proto: object, name: string, label: string) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor?.set || !descriptor.get) return;
    const get = descriptor.get;
    const set = descriptor.set;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get,
      set(value: unknown) {
        const previous = get.call(this);
        set.call(this, value);
        if (previous !== value && this instanceof HTMLVideoElement && shouldWatch(this) && shouldLogVideo(this)) {
          log("video-src", detailOf(this, label), this);
        }
      },
    });
  }

  function pollGetter() {
    const el = document.pictureInPictureElement;
    const present = el != null;
    if (present !== lastGetterPresent) {
      lastGetterPresent = present;
      log("pip-getter", present ? "presente" : "null", el instanceof HTMLVideoElement ? el : null);
      if (el instanceof HTMLVideoElement) {
        const had = hadPipWindow.get(el) ?? false;
        hadPipWindow.set(el, present);
        if (present && !had) announcePipReopen(el, "getter");
      }
    }
  }

  function watchDocumentPip() {
    const pip = window.documentPictureInPicture;
    if (!pip || typeof pip.addEventListener !== "function") return;
    pip.addEventListener("enter", (event) => {
      log("pip-document-abre", "");
      const pipWindow = event.window || pip.window;
      if (!pipWindow) return;
      pipWindow.addEventListener("pagehide", () => log("pip-document-fecha", ""), { once: true });
      const video = pipWindow.document && pipWindow.document.querySelector("video");
      if (video instanceof HTMLVideoElement) note(video);
    });
  }

  function sample() {
    pollGetter();
    pollPipWindows();
    if (!firefoxPollTimer) watchFirefoxPip();
    syncPipUiHint();
    for (const video of known) {
      if (isPlayerVideo(video)) playerVideos.add(video);
      if (!video.isConnected && isLive(video)) adoptDetached(video);
      if (shouldWatch(video)) {
        noteFrame(video);
        tryClaimPipFromVideo(video);
      }
    }
    publishPlayback();
    considerHandoff();
  }

  function boot() {
    const root = document.documentElement;
    if (!root) return false;
    observer = new MutationObserver(onMutations);
    watchRoot(root);
    watchRoot(document);
    scan(document);
    return true;
  }

  log("telemetry-session", "Coleta estruturada iniciada");
  hookInsertionApis();
  hookRemovalApis();
  hookMediaApis();
  watchDocumentPip();
  watchPipUiIntent();
  document.addEventListener("enterpictureinpicture", onEnter as EventListener, true);
  document.addEventListener("leavepictureinpicture", onLeave as EventListener, true);
  window.addEventListener(
    "pointerdown",
    () => {
      if (!enabled || !waitingForGesture || !restorePip) return;
      const candidate = findCandidate();
      if (!candidate) return;
      waitingForGesture = false;
      handoff(candidate);
    },
    true,
  );
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE) return;
    if (data.type === "enabled") {
      enabled = data.value !== false;
      if (!enabled) waitingForGesture = false;
    }
  });

  if (!boot()) {
    const bootObserver = new MutationObserver(() => {
      if (!boot()) return;
      bootObserver.disconnect();
    });
    bootObserver.observe(document, { childList: true });
  }

  window.setInterval(sample, 500);
  bootFirefoxPipWatcher();
  window.postMessage({ source: PAGE_SOURCE, type: "hello" }, "*");
})();

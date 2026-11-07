interface DocumentPictureInPictureEvent extends Event {
  window?: Window;
}

interface DocumentPictureInPicture {
  window: Window | null;
  addEventListener(type: string, listener: (event: DocumentPictureInPictureEvent) => void): void;
}

interface Window {
  documentPictureInPicture?: DocumentPictureInPicture;
}

interface HTMLVideoElement {
  getPictureInPictureWindow?: () => PictureInPictureWindow | null;
  /** Chrome-only no Firefox. Some versões não expõem isto à página. */
  isCloningElementVisually?: boolean;
}

declare const __DEV_OPTIONS__: string;

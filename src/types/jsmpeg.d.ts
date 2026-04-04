type DragonfruitJsmpegPlayerOptions = {
  canvas?: HTMLCanvasElement;
  onVideoDecode?: () => void;
  onSourceEstablished?: () => void;
  [key: string]: unknown;
};

type DragonfruitJsmpegPlayerInstance = {
  destroy?: () => void;
};

type DragonfruitJsmpegNamespace = {
  Player: new (
    url: string,
    options?: DragonfruitJsmpegPlayerOptions,
  ) => DragonfruitJsmpegPlayerInstance;
};

declare global {
  interface Window {
    JSMpeg?: DragonfruitJsmpegNamespace;
  }
}

export {};

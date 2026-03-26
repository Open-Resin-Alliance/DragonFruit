declare global {
  interface Window {
    JSMpeg?: {
      Player: new (
        url: string,
        options: {
          canvas: HTMLCanvasElement;
          onVideoDecode?: () => void;
          onSourceEstablished?: () => void;
        },
      ) => {
        destroy?: () => void;
      };
    };
  }
}

export {};

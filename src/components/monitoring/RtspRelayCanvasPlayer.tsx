'use client';

import React from 'react';

let jsmpegBundleLoadPromise: Promise<void> | null = null;

function ensureJsmpegBundleLoaded(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  if (window.JSMpeg) {
    return Promise.resolve();
  }

  if (jsmpegBundleLoadPromise) {
    return jsmpegBundleLoadPromise;
  }

  jsmpegBundleLoadPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-dragonfruit-jsmpeg="true"]');
    if (existingScript) {
      const readyState = existingScript.getAttribute('data-loaded');
      if (readyState === 'true' && window.JSMpeg) {
        resolve();
        return;
      }

      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Failed to load local JSMpeg bundle.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.dataset.dragonfruitJsmpeg = 'true';
    script.src = '/api/jsmpeg';
    script.onload = () => {
      script.setAttribute('data-loaded', 'true');
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load local JSMpeg bundle.'));
    document.head.appendChild(script);
  }).finally(() => {
    jsmpegBundleLoadPromise = null;
  });

  return jsmpegBundleLoadPromise;
}

type RtspRelayCanvasPlayerProps = {
  url: string;
  className?: string;
  style?: React.CSSProperties;
  onLoaded?: (aspectRatio: number | null) => void;
  onError?: (message: string) => void;
};

function readCanvasAspectRatio(canvas: HTMLCanvasElement): number | null {
  const width = Number(canvas.width || canvas.clientWidth);
  const height = Number(canvas.height || canvas.clientHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

export function RtspRelayCanvasPlayer({
  url,
  className,
  style,
  onLoaded,
  onError,
}: RtspRelayCanvasPlayerProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const onLoadedRef = React.useRef<RtspRelayCanvasPlayerProps['onLoaded']>(onLoaded);
  const onErrorRef = React.useRef<RtspRelayCanvasPlayerProps['onError']>(onError);
  const lastEmittedErrorRef = React.useRef<{ message: string; atEpochMs: number } | null>(null);

  React.useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const emitError = React.useCallback((message: string) => {
    const normalized = message.trim();
    if (!normalized) return;
    const now = Date.now();
    const previous = lastEmittedErrorRef.current;
    if (
      previous
      && previous.message === normalized
      && (now - previous.atEpochMs) < 1250
    ) {
      return;
    }

    lastEmittedErrorRef.current = {
      message: normalized,
      atEpochMs: now,
    };
    onErrorRef.current?.(normalized);
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const normalizedUrl = url.trim();
    if (!/^wss?:\/\//i.test(normalizedUrl)) {
      emitError(`Unsupported rtsp-relay websocket URL: ${normalizedUrl || '(empty)'}`);
      return;
    }

    let disposed = false;
    let destroyed = false;
    let player: { destroy?: () => void } | null = null;
    let hasReceivedFirstFrame = false;
    let lastVideoFrameAt = Date.now();
    let startupTimeoutId: number | null = null;
    let disconnectCheckIntervalId: number | null = null;

    const normalizePlayerErrorMessage = (error: unknown): string => {
      if (error instanceof Error) {
        const message = String(error.message ?? '').trim();
        if (message && message.toLowerCase() !== 'null' && message.toLowerCase() !== 'undefined') {
          return message;
        }
      }
      if (typeof error === 'string') {
        const message = error.trim();
        if (message && message.toLowerCase() !== 'null' && message.toLowerCase() !== 'undefined') {
          return message;
        }
      }
      return 'RTSP relay player failed to initialize. The relay websocket opened but no decodable stream data was available.';
    };

    const onFirstVideoFrame = () => {
      lastVideoFrameAt = Date.now();

      if (hasReceivedFirstFrame) return;
      hasReceivedFirstFrame = true;

      if (startupTimeoutId != null) {
        window.clearTimeout(startupTimeoutId);
        startupTimeoutId = null;
      }

      onLoadedRef.current?.(readCanvasAspectRatio(canvas));
    };

    const safeDestroyPlayer = () => {
      if (destroyed) return;
      destroyed = true;

      if (startupTimeoutId != null) {
        window.clearTimeout(startupTimeoutId);
        startupTimeoutId = null;
      }

      if (disconnectCheckIntervalId != null) {
        window.clearInterval(disconnectCheckIntervalId);
        disconnectCheckIntervalId = null;
      }

      const target = player;
      player = null;
      if (!target || typeof target.destroy !== 'function') return;
      try {
        target.destroy();
      } catch {
        // jsmpeg sometimes throws during teardown when context is already gone.
      }
    };

    void (async () => {
      try {
        await ensureJsmpegBundleLoaded();
        if (disposed) return;

        const jsmpegNamespace = window.JSMpeg;
        if (!jsmpegNamespace) {
          throw new Error('RTSP relay player failed to initialize because the JSMpeg bundle was unavailable.');
        }

        startupTimeoutId = window.setTimeout(() => {
          if (disposed || hasReceivedFirstFrame) return;
          emitError('The webcam stream did not deliver any video data in time.');
          safeDestroyPlayer();
        }, 15_000);

        const createdPlayer = new jsmpegNamespace.Player(normalizedUrl, {
          canvas,
          onVideoDecode: () => {
            if (disposed) return;
            onFirstVideoFrame();
          },
          onSourceEstablished: () => {
            if (disposed) return;
            lastVideoFrameAt = Date.now();
          },
        });

        if (disposed) {
          if (createdPlayer && typeof createdPlayer.destroy === 'function') {
            try {
              createdPlayer.destroy();
            } catch {
              // no-op
            }
          }
          return;
        }

        player = createdPlayer as { destroy?: () => void };

        disconnectCheckIntervalId = window.setInterval(() => {
          if (disposed || !hasReceivedFirstFrame) return;
          if ((Date.now() - lastVideoFrameAt) <= 15_000) return;

          emitError('RTSP relay websocket disconnected.');
          safeDestroyPlayer();
        }, 7_500);
      } catch (error: unknown) {
        if (disposed) return;
        const message = normalizePlayerErrorMessage(error);
        emitError(message);
      }
    })();

    return () => {
      disposed = true;
      safeDestroyPlayer();
    };
  }, [emitError, url]);

  return <canvas ref={canvasRef} className={className} style={style} />;
}

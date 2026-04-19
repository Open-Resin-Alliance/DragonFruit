'use client';

import { useEffect } from 'react';
import {
  getSavedDemandFrameloopSettings,
  resolveDemandFrameloop,
  subscribeToDemandFrameloopSettings,
} from '@/components/settings/demandFrameloopPreferences';

type DiagnosticBreadcrumb = {
  at: string;
  level: 'info' | 'warn' | 'error' | 'event';
  message: string;
  extra?: string;
};

type DiagnosticEvent = {
  at: string;
  kind:
    | 'window-error'
    | 'unhandled-rejection'
    | 'webgl-context-lost'
    | 'webgl-context-restored'
    | 'webgl-context-creation-error'
    | 'raf-stall'
    | 'tauri-callback-warning'
    | 'three-texture-warning';
  message: string;
  stack?: string;
  extra?: string;
};

type MemorySnapshot = {
  jsHeapSizeLimit?: number;
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
};

type CrashDiagnosticSnapshot = {
  capturedAt: string;
  href: string;
  userAgent: string;
  memory?: MemorySnapshot;
  events: DiagnosticEvent[];
  breadcrumbs: DiagnosticBreadcrumb[];
};

const STORAGE_KEY = 'dragonfruit.renderer-crash-diagnostics.v1';
const MAX_BREADCRUMBS = 120;
const MAX_EVENTS = 24;
const RAF_STALL_THRESHOLD_MS = 5000;
const RAF_STALL_COOLDOWN_MS = 12000;

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      return safeStringify(arg);
    })
    .join(' ')
    .slice(0, 1000);
}

function getMemorySnapshot(): MemorySnapshot | undefined {
  if (typeof performance === 'undefined') return undefined;
  const perf = performance as Performance & {
    memory?: {
      jsHeapSizeLimit?: number;
      totalJSHeapSize?: number;
      usedJSHeapSize?: number;
    };
  };

  if (!perf.memory) return undefined;
  return {
    jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
    totalJSHeapSize: perf.memory.totalJSHeapSize,
    usedJSHeapSize: perf.memory.usedJSHeapSize,
  };
}

export function RendererCrashDiagnostics() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    const breadcrumbs: DiagnosticBreadcrumb[] = [];
    const events: DiagnosticEvent[] = [];
    const canvasUnsubscribers = new Map<HTMLCanvasElement, () => void>();

    const persist = () => {
      const snapshot: CrashDiagnosticSnapshot = {
        capturedAt: new Date().toISOString(),
        href: window.location.href,
        userAgent: window.navigator.userAgent,
        memory: getMemorySnapshot(),
        events: [...events],
        breadcrumbs: [...breadcrumbs],
      };

      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Ignore storage failures (quota/private mode/etc).
      }
    };

    const addBreadcrumb = (
      level: DiagnosticBreadcrumb['level'],
      message: string,
      extra?: string,
    ) => {
      breadcrumbs.push({
        at: new Date().toISOString(),
        level,
        message,
        extra,
      });
      if (breadcrumbs.length > MAX_BREADCRUMBS) {
        breadcrumbs.splice(0, breadcrumbs.length - MAX_BREADCRUMBS);
      }
      persist();
    };

    const addEvent = (event: DiagnosticEvent) => {
      events.push(event);
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
      }

      addBreadcrumb('event', event.kind, event.message);
      persist();

      originalError('[RendererCrashDiagnostics]', event.kind, event.message, event.extra ?? '');
      if (event.stack) {
        originalError('[RendererCrashDiagnostics:stack]', event.stack);
      }
    };

    (window as Window & {
      __dragonfruitDumpCrashDiagnostics?: () => CrashDiagnosticSnapshot | null;
      __dragonfruitClearCrashDiagnostics?: () => void;
    }).__dragonfruitDumpCrashDiagnostics = () => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CrashDiagnosticSnapshot;
        originalWarn('[RendererCrashDiagnostics] dump', parsed);
        return parsed;
      } catch {
        return null;
      }
    };

    (window as Window & {
      __dragonfruitClearCrashDiagnostics?: () => void;
    }).__dragonfruitClearCrashDiagnostics = () => {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // no-op
      }
    };

    try {
      const existingRaw = window.localStorage.getItem(STORAGE_KEY);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw) as Partial<CrashDiagnosticSnapshot>;
        const priorEvents = Array.isArray(existing.events) ? existing.events.length : 0;
        if (priorEvents > 0) {
          const lastEvents = Array.isArray(existing.events)
            ? existing.events.slice(-Math.min(6, existing.events.length))
            : [];
          const lastBreadcrumbs = Array.isArray(existing.breadcrumbs)
            ? existing.breadcrumbs.slice(-Math.min(12, existing.breadcrumbs.length))
            : [];

          originalWarn('[RendererCrashDiagnostics] Previous crash snapshot found. Run window.__dragonfruitDumpCrashDiagnostics() to inspect.', {
            capturedAt: existing.capturedAt,
            priorEvents,
            lastEvents,
            lastBreadcrumbs,
          });
        }
      }
    } catch {
      // Ignore malformed or inaccessible persisted snapshots.
    }

    console.warn = (...args: unknown[]) => {
      const message = summarizeConsoleArgs(args);
      addBreadcrumb('warn', message);

      const lower = message.toLowerCase();
      if (lower.includes("couldn't find callback id") && lower.includes('[tauri]')) {
        addEvent({
          at: new Date().toISOString(),
          kind: 'tauri-callback-warning',
          message,
        });
      } else if (lower.includes('texture marked for update') && lower.includes('no image data')) {
        addEvent({
          at: new Date().toISOString(),
          kind: 'three-texture-warning',
          message,
        });
      }

      originalWarn(...args);
    };

    console.error = (...args: unknown[]) => {
      const message = summarizeConsoleArgs(args);
      addBreadcrumb('error', message);
      originalError(...args);
    };

    const onWindowError = (event: ErrorEvent) => {
      // ResizeObserver loop notifications are benign browser warnings, not real errors.
      if (event.message?.includes('ResizeObserver loop')) return;
      addEvent({
        at: new Date().toISOString(),
        kind: 'window-error',
        message: event.message || 'Unknown window error',
        stack: event.error instanceof Error ? event.error.stack : undefined,
        extra: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      addEvent({
        at: new Date().toISOString(),
        kind: 'unhandled-rejection',
        message: reason instanceof Error ? reason.message : safeStringify(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };

    const onWebGlContextLost = (event: Event) => {
      const target = event.target as HTMLCanvasElement | null;
      const size = target
        ? `${target.width}x${target.height}`
        : 'unknown-canvas-size';

      addEvent({
        at: new Date().toISOString(),
        kind: 'webgl-context-lost',
        message: 'WebGL context lost',
        extra: size,
      });
    };

    const onWebGlContextRestored = (event: Event) => {
      const target = event.target as HTMLCanvasElement | null;
      const size = target
        ? `${target.width}x${target.height}`
        : 'unknown-canvas-size';

      addEvent({
        at: new Date().toISOString(),
        kind: 'webgl-context-restored',
        message: 'WebGL context restored',
        extra: size,
      });
    };

    const onWebGlContextCreationError = (event: Event) => {
      const webglEvent = event as Event & { statusMessage?: string };
      const target = event.target as HTMLCanvasElement | null;
      const size = target
        ? `${target.width}x${target.height}`
        : 'unknown-canvas-size';
      const status = webglEvent.statusMessage?.trim();

      addEvent({
        at: new Date().toISOString(),
        kind: 'webgl-context-creation-error',
        message: 'WebGL context creation error',
        extra: status
          ? `${size} | ${status}`
          : size,
      });
    };

    const untrackCanvas = (canvas: HTMLCanvasElement) => {
      const dispose = canvasUnsubscribers.get(canvas);
      if (!dispose) return;
      dispose();
      canvasUnsubscribers.delete(canvas);
    };

    const trackCanvas = (canvas: HTMLCanvasElement) => {
      if (canvasUnsubscribers.has(canvas)) return;

      const onLost = (event: Event) => {
        // Keep default behavior unchanged, just observe diagnostics.
        onWebGlContextLost(event);
      };

      const onRestored = (event: Event) => {
        onWebGlContextRestored(event);
      };

      const onCreationError = (event: Event) => {
        onWebGlContextCreationError(event);
      };

      canvas.addEventListener('webglcontextlost', onLost as EventListener, false);
      canvas.addEventListener('webglcontextrestored', onRestored as EventListener, false);
      canvas.addEventListener('webglcontextcreationerror', onCreationError as EventListener, false);

      canvasUnsubscribers.set(canvas, () => {
        canvas.removeEventListener('webglcontextlost', onLost as EventListener, false);
        canvas.removeEventListener('webglcontextrestored', onRestored as EventListener, false);
        canvas.removeEventListener('webglcontextcreationerror', onCreationError as EventListener, false);
      });
    };

    const scanExistingCanvases = () => {
      document.querySelectorAll('canvas').forEach((node) => {
        if (node instanceof HTMLCanvasElement) {
          trackCanvas(node);
        }
      });
    };

    const trackNodeCanvases = (node: Node) => {
      if (node instanceof HTMLCanvasElement) {
        trackCanvas(node);
        return;
      }

      if (node instanceof Element) {
        node.querySelectorAll('canvas').forEach((child) => {
          if (child instanceof HTMLCanvasElement) {
            trackCanvas(child);
          }
        });
      }
    };

    const untrackNodeCanvases = (node: Node) => {
      if (node instanceof HTMLCanvasElement) {
        untrackCanvas(node);
        return;
      }

      if (node instanceof Element) {
        node.querySelectorAll('canvas').forEach((child) => {
          if (child instanceof HTMLCanvasElement) {
            untrackCanvas(child);
          }
        });
      }
    };

    scanExistingCanvases();

    const canvasObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          trackNodeCanvases(node);
        });
        mutation.removedNodes.forEach((node) => {
          untrackNodeCanvases(node);
        });
      });
    });

    const observeRoot = document.body ?? document.documentElement;
    if (observeRoot) {
      canvasObserver.observe(observeRoot, { childList: true, subtree: true });
    }

    let rafId = 0;
    let stallTimerId: number | null = null;
    let lastRafMs = performance.now();
    let lastStallReportMs = 0;

    const onRaf = (now: number) => {
      lastRafMs = now;
      rafId = window.requestAnimationFrame(onRaf);
    };

    rafId = window.requestAnimationFrame(onRaf);

    // In demand-mode rendering, the compositor intentionally pauses rAF when
    // the scene is idle — that's the whole point (saves CPU). The stall check
    // would fire constantly. Suppress raf-stall events while demand mode is
    // the resolved frameloop; re-enable if the user flips back to always.
    let demandModeActive = resolveDemandFrameloop(getSavedDemandFrameloopSettings()) === 'demand';
    const unsubscribeDemand = subscribeToDemandFrameloopSettings(() => {
      demandModeActive = resolveDemandFrameloop(getSavedDemandFrameloopSettings()) === 'demand';
    });

    stallTimerId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (demandModeActive) return;

      const now = performance.now();
      const delta = now - lastRafMs;
      if (delta < RAF_STALL_THRESHOLD_MS) return;
      if ((now - lastStallReportMs) < RAF_STALL_COOLDOWN_MS) return;

      lastStallReportMs = now;
      addEvent({
        at: new Date().toISOString(),
        kind: 'raf-stall',
        message: 'Render loop stall detected',
        extra: `${Math.round(delta)}ms since last animation frame`,
      });
    }, 2000);

    const onSlicingProgress = (event: Event) => {
      const custom = event as CustomEvent<{ phase?: string; done?: number; total?: number }>;
      const detail = custom.detail ?? {};
      const phase = typeof detail.phase === 'string' ? detail.phase : 'unknown';
      const done = Number.isFinite(detail.done) ? Number(detail.done) : 0;
      const total = Number.isFinite(detail.total) ? Number(detail.total) : 0;
      addBreadcrumb('info', `Slicing progress ${phase}`, `${done}/${total}`);
    };

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('dragonfruit:slicing-progress', onSlicingProgress as EventListener);

    addBreadcrumb('info', 'RendererCrashDiagnostics attached');

    return () => {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('dragonfruit:slicing-progress', onSlicingProgress as EventListener);

      canvasObserver.disconnect();
      canvasUnsubscribers.forEach((dispose) => dispose());
      canvasUnsubscribers.clear();

      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (stallTimerId != null) {
        window.clearInterval(stallTimerId);
      }
      unsubscribeDemand();

      console.warn = originalWarn;
      console.error = originalError;
    };
  }, []);

  return null;
}

export default RendererCrashDiagnostics;

"use client";

import { useEffect } from "react";
import { startMainThreadHeartbeat } from "@/utils/debug/mainThreadHeartbeat";
import { logStartupHeader } from "@/utils/debug/startupHeader";
import { startWebviewHeartbeat } from "@/utils/debug/webviewHeartbeat";
import { logToNativeFile } from "@/utils/nativeLog";

/**
 * Wires the webview into the native Tauri log in both directions:
 *
 * - Rust-side log entries are echoed to the webview's devtools console.
 * - `console.warn` / `console.error`, uncaught errors and unhandled promise
 *   rejections are also written to the platform log file (e.g.
 *   %APPDATA%\org.openresinalliance.dragonfruit\logs\dragonfruit.log), tagged
 *   `[webview]`. Without this a frontend failure on a user's machine leaves
 *   no trace in the log they send us.
 *
 * The echo uses `attachLogger` with the console methods captured before they
 * are wrapped, not `attachConsole`: that one calls the global `console.warn`,
 * which would forward every Rust warning straight back to Rust.
 *
 * Also starts the main-thread stall detector and writes the webview half of the
 * startup header. Both are cheap enough to run unconditionally: the detector is
 * one timer at 4 Hz that logs only when something is already wrong.
 *
 * The log plugin is skipped outside of a Tauri context (e.g. browser
 * dev); the stall detector still runs there and reports to the console.
 */
export function AppLogger() {
  useEffect(() => {
    const isTauri =
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in window;

    const stopHeartbeat = startMainThreadHeartbeat();
    const stopWebviewHeartbeat = startWebviewHeartbeat();

    if (!isTauri) {
      logStartupHeader((message) => console.info(message));
      return () => {
        stopHeartbeat();
        stopWebviewHeartbeat();
      };
    }

    const stopForwarding = forwardWebviewProblemsToNativeLog();
    let detach: (() => void) | undefined;
    let disposed = false;

    import("@tauri-apps/plugin-log")
      .then(({ attachLogger, LogLevel, info }) => {
        attachLogger(({ level, message }) => {
          // Our own forwarded lines come back through the webview target; the
          // wrapped console already showed them once.
          if (message.includes(WEBVIEW_TAG)) return;
          switch (level) {
            case LogLevel.Trace: originalConsole.log(message); break;
            case LogLevel.Debug: originalConsole.debug(message); break;
            case LogLevel.Info: originalConsole.info(message); break;
            case LogLevel.Warn: originalConsole.warn(message); break;
            default: originalConsole.error(message); break;
          }
        }).then((detachFn) => {
          if (disposed) {
            detachFn();
            return;
          }
          detach = detachFn;
          info("Frontend logger attached");
          logStartupHeader((message) => {
            void info(message);
          });
        }).catch((err) => {
          originalConsole.error("[AppLogger] failed to attach to the log plugin:", err);
        });
      })
      .catch((err) => {
        // Fallback: log plugin import failed (shouldn't happen in Tauri bundle)
        originalConsole.error("[AppLogger] failed to load the log plugin:", err);
      });

    return () => {
      disposed = true;
      detach?.();
      stopForwarding();
      stopHeartbeat();
      stopWebviewHeartbeat();
    };
  }, []);

  return null;
}

const WEBVIEW_TAG = "[webview]";

/** Longest single forwarded entry; a dumped object must not flood the log. */
const MAX_FORWARDED_LENGTH = 4000;

/** The console methods as they were before this module wrapped any of them. */
const originalConsole = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function forward(level: "warn" | "error", parts: unknown[]): void {
  let text = parts.map(describe).join(" ");
  if (text.length > MAX_FORWARDED_LENGTH) {
    text = `${text.slice(0, MAX_FORWARDED_LENGTH)}… (${text.length} chars)`;
  }
  void logToNativeFile(level, `${WEBVIEW_TAG} ${text}`);
}

/** Starts forwarding; returns a function that undoes it. */
function forwardWebviewProblemsToNativeLog(): () => void {
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    forward("warn", args);
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    forward("error", args);
  };

  const onError = (event: ErrorEvent) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    // i18n-ignore — log-file text, never shown in the UI
    forward("error", [`Uncaught ${event.message}${where}`, ...(event.error ? [event.error] : [])]);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    forward("error", ["Unhandled promise rejection:", event.reason]);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

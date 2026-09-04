"use client";

import { useEffect } from "react";
import { startMainThreadHeartbeat } from "@/utils/debug/mainThreadHeartbeat";
import { logStartupHeader } from "@/utils/debug/startupHeader";
import { startWebviewHeartbeat } from "@/utils/debug/webviewHeartbeat";

/**
 * Attaches the native Tauri log plugin to the browser console so that all
 * console.log / warn / error calls made anywhere in the frontend are written
 * to the platform log file (e.g. %APPDATA%\org.openresinalliance.dragonfruit\logs\dragonfruit.log).
 *
 * Also starts the main-thread stall detector and writes the webview half of the
 * startup header. Both are cheap enough to run unconditionally: the detector is
 * one timer at 4 Hz that logs only when something is already wrong.
 *
 * The console attachment is a no-op outside of a Tauri context (e.g. browser
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

    let detach: (() => void) | undefined;

    import("@tauri-apps/plugin-log")
      .then(({ attachConsole, info }) => {
        attachConsole().then((detachFn) => {
          detach = detachFn;
          info("Frontend logger attached");
          logStartupHeader((message) => {
            void info(message);
          });
        });
      })
      .catch((err) => {
        // Fallback: log plugin import failed (shouldn't happen in Tauri bundle)
        console.error("[AppLogger] failed to attach console to log plugin:", err);
      });

    return () => {
      detach?.();
      stopHeartbeat();
      stopWebviewHeartbeat();
    };
  }, []);

  return null;
}

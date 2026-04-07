"use client";

import { useEffect } from "react";

/**
 * Attaches the native Tauri log plugin to the browser console so that all
 * console.log / warn / error calls made anywhere in the frontend are written
 * to the platform log file (e.g. %APPDATA%\org.openresinalliance.dragonfruit\logs\dragonfruit.log).
 *
 * This is a no-op when running outside of a Tauri context (e.g. browser dev).
 */
export function AppLogger() {
  useEffect(() => {
    const isTauri =
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in window;

    if (!isTauri) return;

    let detach: (() => void) | undefined;

    import("@tauri-apps/plugin-log")
      .then(({ attachConsole, info }) => {
        attachConsole().then((detachFn) => {
          detach = detachFn;
          info("Frontend logger attached");
        });
      })
      .catch((err) => {
        // Fallback: log plugin import failed (shouldn't happen in Tauri bundle)
        console.error("[AppLogger] failed to attach console to log plugin:", err);
      });

    return () => {
      detach?.();
    };
  }, []);

  return null;
}

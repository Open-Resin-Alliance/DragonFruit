/**
 * Write a line to DragonFruit's own log file.
 *
 * The log file is the only place the renderer's import pipeline can be read next
 * to the Rust timings it is measured against — `%APPDATA%/org.openresinalliance.dragonfruit/logs/dragonfruit.log`
 * — and only `tauri-plugin-log` reaches it: `attachConsole` forwards Rust records
 * *to* DevTools, never the other way, so a plain `console.*` from here appears
 * nowhere near the native lines it belongs with. See `AppLogger.tsx`.
 *
 * Best-effort: a log line must never be what fails a load, and outside a Tauri
 * context (the web build, `npm test`) the caller's own `console.*` stands alone.
 */
export async function logToNativeFile(
  level: 'info' | 'warn' | 'error',
  message: string,
): Promise<void> {
  try {
    // Dynamic because this module does not exist outside a Tauri context, where
    // importing it statically would break every web/test consumer of the callers.
    const log = await import('@tauri-apps/plugin-log');
    await log[level](message);
  } catch {
    // Nothing to write to.
  }
}

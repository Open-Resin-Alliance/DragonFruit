/**
 * Where the performance probes write. In the desktop app that is
 * dragonfruit.log through the log plugin, so a tester only has to send the log;
 * in a plain browser it is the console. Lines are tagged `[perf:<probe>]`.
 */

export type PerfLogFn = (message: string) => void;

export interface PerfLogger {
    info: PerfLogFn;
    warn: PerfLogFn;
}

/**
 * A logger that writes to the console until the log plugin has loaded, then
 * to the native log. The plugin is imported lazily so nothing here delays the
 * first paint.
 */
export function createPerfLogger(): PerfLogger {
    const logger: PerfLogger = {
        info: (message) => console.info(message),
        warn: (message) => console.warn(message),
    };
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isTauri) return logger;

    void import('@tauri-apps/plugin-log')
        .then(({ info, warn }) => {
            logger.info = (message) => { void info(message); };
            logger.warn = (message) => { void warn(message); };
        })
        .catch(() => {
            // Keep the console fallback.
        });
    return logger;
}

/** Rounds to whole milliseconds; finer precision is noise in these reports. */
export function ms(value: number): string {
    return `${Math.round(value)}ms`;
}

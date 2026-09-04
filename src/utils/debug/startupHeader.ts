/**
 * Fixed header written once per run, from the webview side.
 *
 * Without it every performance report floats in a vacuum: a 12-second freeze
 * means nothing until you know whether it happened on an M4 Max or a 2017 iMac.
 * The Rust side logs what the process knows (version, OS, CPU count); this logs
 * what only the webview can see.
 *
 * Nothing here is user data — no paths, no model names.
 */

type LogFn = (message: string) => void;

/**
 * Queries the GPU string. WebKit may mask this for fingerprinting reasons, in
 * which case the generic renderer name is still worth having.
 */
function describeGpu(): string {
    let canvas: HTMLCanvasElement | null = null;
    try {
        canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (!gl) return 'no WebGL context';

        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debugInfo
            ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER);

        // Release the context immediately — a lingering one costs a GPU process
        // slot for the whole session.
        gl.getExtension('WEBGL_lose_context')?.loseContext();

        return typeof renderer === 'string' && renderer.length > 0 ? renderer : 'unknown';
    } catch {
        return 'unavailable';
    } finally {
        canvas?.remove();
    }
}

/** Writes the webview half of the startup header. */
export function logStartupHeader(info: LogFn): void {
    if (typeof window === 'undefined') return;

    const { width, height } = window.screen;
    info(
        `[header] gpu=${describeGpu()} `
        + `viewport=${window.innerWidth}x${window.innerHeight} `
        + `screen=${width}x${height}@${window.devicePixelRatio}x `
        + `cores=${navigator.hardwareConcurrency ?? 'unknown'}`,
    );
}

/**
 * The size of the 3D view's drawing buffer, which is what the GPU fills every
 * frame. The startup header records the window and screen, but on a Retina
 * screen the canvas renders at the device pixel ratio, so a 1500-pixel-wide
 * view can be a 3000-pixel-wide buffer: four times the fill work of what the
 * window size suggests. On an old integrated GPU that alone can explain a slow
 * orbit.
 */

import type { PerfLogger } from './perfLog';

/**
 * The scene canvas: of the canvases react-three-fiber marks with `data-engine`,
 * the one with the largest drawing buffer. The first one in the document is not
 * it: Support Studio's anatomy preview is an R3F canvas too, and once it mounted
 * every scene and camera line described that 143x432 preview instead.
 */
export function findSceneCanvas(root: ParentNode = document): HTMLCanvasElement | null {
    let best: HTMLCanvasElement | null = null;
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas[data-engine]')) {
        if (!best || canvas.width * canvas.height > best.width * best.height) best = canvas;
    }
    return best;
}

/**
 * One-line description of the scene canvas, or null while there is none.
 * Asking for the context type the canvas already has returns that context and
 * creates nothing.
 */
export function describeSceneCanvas(): string | null {
    const canvas = findSceneCanvas();
    if (!canvas) return null;

    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const bufferWidth = gl?.drawingBufferWidth ?? canvas.width;
    const bufferHeight = gl?.drawingBufferHeight ?? canvas.height;
    const scale = cssWidth > 0 ? bufferWidth / cssWidth : 0;
    const megapixels = (bufferWidth * bufferHeight) / 1e6;

    let extras = '';
    if (gl) {
        const attributes = gl.getContextAttributes();
        const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        extras = ` webgl${webgl2 ? 2 : 1}`
            + ` antialias=${attributes?.antialias === true}`
            + (webgl2 ? ` msaaMax=${(gl as WebGL2RenderingContext).getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES)}` : '')
            + ` gpuTimer=${gl.getSupportedExtensions()?.includes('EXT_disjoint_timer_query_webgl2') === true}`;
    }

    return `css=${cssWidth}x${cssHeight} buffer=${bufferWidth}x${bufferHeight} `
        + `scale=${scale.toFixed(2)} (${megapixels.toFixed(1)} MP/frame)${extras}`;
}

const POLL_MS = 2000;

/**
 * Logs the scene canvas when it first appears and whenever its buffer size
 * changes (a window resize, a dock opening, the DPR dropping during an
 * animation). A two-second poll is enough: this is about the steady state.
 */
export function startCanvasBufferLog(logger: PerfLogger): () => void {
    if (typeof window === 'undefined') return () => { };

    let lastCanvas: HTMLCanvasElement | null = null;
    let lastSize = '';
    const check = () => {
        const canvas = findSceneCanvas();
        if (!canvas) return;
        const size = `${canvas.width}x${canvas.height}`;
        if (canvas === lastCanvas && size === lastSize) return;
        const first = lastCanvas === null;
        lastCanvas = canvas;
        lastSize = size;
        const description = describeSceneCanvas();
        if (description) logger.info(`[perf:canvas] ${first ? 'scene canvas' : 'scene canvas changed'} ${description}`);
    };

    const intervalId = window.setInterval(check, POLL_MS);
    check();
    return () => window.clearInterval(intervalId);
}

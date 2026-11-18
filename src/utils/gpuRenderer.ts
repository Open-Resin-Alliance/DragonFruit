/**
 * Reads the WebGL renderer string and classifies it.
 *
 * WebView2 on Windows can leave the GPU process on the integrated adapter even
 * when a discrete one exists; the renderer string is the only signal the
 * webview has about which adapter it actually got. The classification is
 * deliberately conservative: an unrecognised string returns `unknown`, so the
 * warning never fires on a guess.
 */

export type GpuRendererKind = 'integrated' | 'discrete' | 'software' | 'unknown';

/** The unmasked renderer string, or `null` when no context can be created. */
export function readGpuRendererName(): string | null {
  if (typeof document === 'undefined') return null;

  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);

    // Release the context immediately — a lingering one costs a GPU process
    // slot for the whole session.
    gl.getExtension('WEBGL_lose_context')?.loseContext();

    return typeof renderer === 'string' && renderer.length > 0 ? renderer : null;
  } catch {
    return null;
  } finally {
    canvas?.remove();
  }
}

/**
 * Classifies a renderer string.
 *
 * Discrete patterns are checked before integrated ones because several
 * integrated names contain a discrete vendor name (`Intel Arc` is discrete,
 * `Intel UHD Graphics` is not; `Radeon RX` is discrete, `Radeon Graphics` is an
 * APU). Software rasterisers are checked first because they are the worst case
 * and their names can contain a vendor.
 */
export function classifyGpuRenderer(renderer: string): GpuRendererKind {
  const name = renderer.toLowerCase();

  if (/swiftshader|llvmpipe|microsoft basic render|software rasterizer|warp/.test(name)) {
    return 'software';
  }

  if (/nvidia|geforce|quadro|rtx|gtx|radeon rx|radeon pro|intel.*arc|arc\s*[ab]\d/.test(name)) {
    return 'discrete';
  }

  if (/intel|uhd graphics|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d|radeon \d+m|apple m\d|adreno|mali/.test(name)) {
    return 'integrated';
  }

  return 'unknown';
}

/** True on Windows, where WebView2's GPU process can pick the integrated adapter. */
export function isWindowsWebview(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /windows/i.test(navigator.userAgent);
}

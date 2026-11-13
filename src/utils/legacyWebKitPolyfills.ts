/**
 * The few web APIs the app (and its bundled plugins) call that the macOS 12
 * webview lacks.
 *
 * A webview is the WebKit its macOS shipped with, not the user's Safari: macOS
 * 12 stays on WebKit 15.6 however new its Safari is. SWC lowers syntax for that
 * target (browserslist), and `tsc`'s `lib` keeps newer language APIs out, but
 * neither knows which DOM APIs a WebKit has. These two were found by a tester
 * on macOS 12, each one a crash the first time it ran:
 *
 * - `CanvasRenderingContext2D.prototype.roundRect` (Safari 16.0), drawn by the
 *   axis gizmo's home chip as soon as a model is in the scene;
 * - `AbortSignal.timeout` (Safari 16.0), used by the plugin manifest fetches
 *   and the printer network plugins.
 *
 * Each is installed only where it is missing, so a current webview keeps its
 * own. Delete this module when macOS 12 is dropped (see the temporary rule in
 * `docs/dev/backlog.md`).
 */

type CornerRadius = number | DOMPointInit;

interface PolyfillScope {
  AbortSignal?: { timeout?: (milliseconds: number) => AbortSignal };
  AbortController?: typeof AbortController;
  DOMException?: typeof DOMException;
  CanvasRenderingContext2D?: { prototype: Partial<CanvasRenderingContext2D> };
  OffscreenCanvasRenderingContext2D?: { prototype: Partial<OffscreenCanvasRenderingContext2D> };
}

export function installLegacyWebKitPolyfills(scope: PolyfillScope = globalThis as PolyfillScope): void {
  installAbortSignalTimeout(scope);
  installRoundRect(scope.CanvasRenderingContext2D?.prototype);
  installRoundRect(scope.OffscreenCanvasRenderingContext2D?.prototype);
}

function installAbortSignalTimeout(scope: PolyfillScope): void {
  const signalClass = scope.AbortSignal;
  const controllerClass = scope.AbortController;
  if (!signalClass || !controllerClass || typeof signalClass.timeout === 'function') return;
  const exceptionClass = scope.DOMException;
  signalClass.timeout = (milliseconds: number): AbortSignal => {
    const controller = new controllerClass();
    setTimeout(() => {
      // The native one aborts with a `TimeoutError`, which callers tell apart
      // from a user's `AbortError`.
      const reason = exceptionClass
        ? new exceptionClass('signal timed out', 'TimeoutError')
        : Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
      controller.abort(reason);
    }, milliseconds);
    return controller.signal;
  };
}

type RoundRectTarget = Partial<Pick<CanvasRenderingContext2D, 'roundRect'>>;

function installRoundRect(prototype: RoundRectTarget | undefined): void {
  if (!prototype || typeof prototype.roundRect === 'function') return;
  prototype.roundRect = function roundRect(
    this: CanvasPath,
    x: number,
    y: number,
    width: number,
    height: number,
    radii: CornerRadius | CornerRadius[] = 0,
  ): void {
    traceRoundRect(this, x, y, width, height, radii);
  };
}

/**
 * The `roundRect` path, built from `moveTo`/`arcTo`. Takes the spec's 1–4
 * radii (CSS `border-radius` order); a `DOMPointInit` corner uses its `x`
 * only, so elliptical corners come out circular. Radii that do not fit are
 * scaled down together, as the spec does.
 */
export function traceRoundRect(
  path: Pick<CanvasPath, 'moveTo' | 'arcTo' | 'closePath'>,
  x: number,
  y: number,
  width: number,
  height: number,
  radii: CornerRadius | CornerRadius[] = 0,
): void {
  const list = (Array.isArray(radii) ? radii : [radii]).map((r) => Math.max(0, typeof r === 'number' ? r : (r.x ?? 0)));
  const [a = 0, b = a, c = a, d = b] = list;
  // top-left, top-right, bottom-right, bottom-left
  let corners = list.length === 3 ? [a, b, c, b] : [a, b, c, d];
  const w = Math.abs(width);
  const h = Math.abs(height);
  const scale = Math.min(
    1,
    w / (corners[0] + corners[1] || Infinity),
    w / (corners[3] + corners[2] || Infinity),
    h / (corners[0] + corners[3] || Infinity),
    h / (corners[1] + corners[2] || Infinity),
  );
  corners = corners.map((r) => r * scale);
  const [tl, tr, br, bl] = corners;
  const left = Math.min(x, x + width);
  const top = Math.min(y, y + height);
  const right = left + w;
  const bottom = top + h;
  path.moveTo(left + tl, top);
  path.arcTo(right, top, right, bottom, tr);
  path.arcTo(right, bottom, left, bottom, br);
  path.arcTo(left, bottom, left, top, bl);
  path.arcTo(left, top, right, top, tl);
  path.closePath();
}

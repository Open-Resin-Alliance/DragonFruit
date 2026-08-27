/**
 * JS side of the native 3DxWare / navlib SpaceMouse bridge (Windows/macOS).
 *
 * The 3Dconnexion driver grabs the HID device and computes camera motion itself
 * (the navlib "navigation library" model). The webview can't call the driver
 * directly, so the Rust host (`src-tauri/src/spacemouse`) owns navlib and exposes
 * three commands; this module is the typed, Tauri-aware wrapper around them:
 *
 *   - `nativeSpaceMouseStart()` — load navlib + create the instance.
 *   - `nativeSpaceMouseStop()`  — tear it down.
 *   - `nativeSpaceMouseSync(cam)` — one frame: push the current camera, receive
 *     navlib's latest camera pose.
 *
 * When the driver is absent (Linux, no 3DxWare, dev in a browser) `start`
 * resolves to `null` and the caller falls back to the Gamepad-API path
 * (`SpaceMouseController`).
 */
import { isTauriRuntime } from '@/utils/tauriRuntime';

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let tauriCorePromise: Promise<{ invoke: TauriInvoke } | null> | null = null;


async function loadInvoke(): Promise<TauriInvoke | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke as TauriInvoke }))
      .catch(() => null);
  }
  const core = await tauriCorePromise;
  return core?.invoke ?? null;
}

/** Camera + scene snapshot pushed to navlib each frame. Field names match the
 *  Rust `CameraInput` (serde `camelCase`). */
export type NativeCameraInput = {
  /** Camera-to-world matrix as three.js `Matrix4.elements` (column-major). */
  affine: number[];
  /** Vertical field of view in radians. */
  fov: number;
  /** Distance from the camera to the look-at / pivot point. */
  focusDistance: number;
  perspective: boolean;
  target: [number, number, number];
  modelMin: [number, number, number];
  modelMax: [number, number, number];
  /** Orthographic view extents in camera/eye space (min/max of the view box).
   *  navlib uses these to scale pan and drive zoom while `perspective` is false. */
  orthoMin: [number, number, number];
  orthoMax: [number, number, number];
};

/** navlib's latest camera output. Matches the Rust `NavOutput`. */
export type NativeNavOutput = {
  /** Camera-to-world matrix, same layout as {@link NativeCameraInput.affine}. */
  affine: number[];
  /** Advances on every navlib affine write; use it to detect fresh frames. */
  seq: number;
  /** True while the driver is actively navigating (exclusive control). */
  motion: boolean;
  /** Orthographic view extents navlib produced; map the width onto `camera.zoom`. */
  orthoMin: [number, number, number];
  orthoMax: [number, number, number];
  /** Advances on every navlib extents write (ortho zoom). */
  extentsSeq: number;
};

async function rawStart(): Promise<string | null> {
  const invoke = await loadInvoke();
  if (!invoke) return null;
  try {
    return await invoke<string>('spacemouse_native_start');
  } catch {
    // navlib absent or failed to create — fall back silently.
    return null;
  }
}

async function rawStop(): Promise<void> {
  const invoke = await loadInvoke();
  if (!invoke) return;
  try {
    await invoke<void>('spacemouse_native_stop');
  } catch {
    /* ignore */
  }
}

/**
 * One frame of the bridge. Pushes the current camera; returns navlib's latest.
 * Returns `null` if the runtime is unavailable or the call fails.
 */
export async function nativeSpaceMouseSync(
  cam: NativeCameraInput,
): Promise<NativeNavOutput | null> {
  const invoke = await loadInvoke();
  if (!invoke) return null;
  try {
    return await invoke<NativeNavOutput>('spacemouse_native_sync', { cam });
  } catch {
    return null;
  }
}

// ─── Gamepad-suppression flag ────────────────────────────────────────────
//
// While the native bridge is driving the camera, the Gamepad-API controller
// must not also read the same physical puck (both APIs can see it — see the
// "Fallback device detected" log). This tiny store lets `SpaceMouseController`
// stand down whenever the native path is live.

let nativeActive = false;
const activeListeners = new Set<() => void>();

function setNativeSpaceMouseActive(value: boolean): void {
  if (value === nativeActive) return;
  nativeActive = value;
  for (const listener of activeListeners) listener();
}

export function getNativeSpaceMouseActive(): boolean {
  return nativeActive;
}

export function subscribeNativeSpaceMouseActive(callback: () => void): () => void {
  activeListeners.add(callback);
  return () => {
    activeListeners.delete(callback);
  };
}

// ─── Desired-state lifecycle reconciler ──────────────────────────────────
//
// navlib is a process-wide singleton, but the controller that owns it is a React
// component whose start/stop effect is double-invoked under StrictMode (dev) and
// resolves asynchronously. Rather than guard flags that can race into a
// permanently-stopped state, callers express intent via `requestNativeSpaceMouse`
// and this reconciler drives `current` toward `desired`, serializing all start/
// stop calls so they can never overlap or land out of order.

let desiredOn = false;
let currentOn = false;
let reconciling = false;

async function reconcile(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    while (desiredOn !== currentOn) {
      if (desiredOn) {
        const loadedFrom = await rawStart();
        if (loadedFrom == null) {
          // Driver absent — stop asking so we don't spin retrying every tick.
          // A later enable toggle will request again.
          desiredOn = false;
          break;
        }
        currentOn = true;
        setNativeSpaceMouseActive(true);
        console.info(`[3DMouse] Native navlib bridge active (from ${loadedFrom})`);
      } else {
        await rawStop();
        currentOn = false;
        setNativeSpaceMouseActive(false);
      }
    }
  } finally {
    reconciling = false;
  }
}

/**
 * Express whether the native bridge should be running. Idempotent and safe to
 * call repeatedly (StrictMode, setting toggles); the reconciler converges to the
 * latest requested state, serializing the underlying start/stop calls.
 */
export function requestNativeSpaceMouse(on: boolean): void {
  desiredOn = on;
  void reconcile();
}

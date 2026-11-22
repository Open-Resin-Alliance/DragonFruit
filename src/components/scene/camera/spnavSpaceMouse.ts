/**
 * spacenavd source for the Gamepad-API SpaceMouse path (Linux).
 *
 * Linux has no navlib, and the webview's Gamepad API rarely sees the puck there:
 * spacenavd grabs the device by default, and the Flatpak sandbox has no
 * `/dev/input` at all. The Rust host reads spacenavd instead
 * (`src-tauri/src/spacemouse/spnav.rs`) and pushes the axes, already in the HID
 * layout a browser pad reports. This module wraps that state in a synthetic
 * `Gamepad`, so `SpaceMouseController` and the settings tab treat it like any
 * other detected 3D mouse: same tuning, inversion, pivot modes and block list.
 */
import { isTauriRuntime } from '@/utils/tauriRuntime';

/** Mirrors the Rust `SpnavState` (serde `camelCase`). */
type SpnavState = {
  connected: boolean;
  axes: number[];
  buttons: boolean[];
};

/** Device id shown in Settings → 3D Mouse; matches `NAMED_3D_MOUSE`. */
export const SPNAV_DEVICE_ID = '3Dconnexion SpaceMouse (spacenavd)';
const SPNAV_EVENT = 'spacemouse://spnav';

let started = false;
let pad: Gamepad | null = null;

export function spnavStateToGamepad(state: SpnavState): Gamepad | null {
  if (!state.connected) return null;
  // Only the fields the controllers read are meaningful; the rest satisfy the type.
  return {
    id: SPNAV_DEVICE_ID,
    index: -1,
    connected: true,
    mapping: '',
    timestamp: performance.now(),
    axes: state.axes,
    buttons: state.buttons.map((pressed) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })),
    vibrationActuator: null,
  } as unknown as Gamepad;
}

async function start(): Promise<void> {
  let unlisten: (() => void) | null = null;
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]);
    let sawEvent = false;
    unlisten = await listen<SpnavState>(SPNAV_EVENT, (event) => {
      sawEvent = true;
      pad = spnavStateToGamepad(event.payload);
    });
    const initial = await invoke<SpnavState>('spacemouse_spnav_start');
    // An event that landed during the call is newer than its reply.
    if (!sawEvent) pad = spnavStateToGamepad(initial);
  } catch {
    // Not Linux (the command refuses) or the runtime is unavailable.
    unlisten?.();
  }
}

/**
 * The spacenavd puck as a `Gamepad`, or `null` while spacenavd is absent or not
 * connected. The first call starts the host-side client; it is cheap enough to
 * call every frame.
 */
export function getSpnavGamepad(): Gamepad | null {
  if (!started) {
    started = true;
    if (isTauriRuntime()) void start();
  }
  return pad;
}

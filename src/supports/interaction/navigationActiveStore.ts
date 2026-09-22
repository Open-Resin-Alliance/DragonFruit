/**
 * Whether a 3D mouse (SpaceMouse) is currently driving the camera.
 *
 * SpaceMouse navigation keeps GPU picking live, so the hover point changes as
 * the camera moves. The support trunk router is far too heavy to run every one
 * of those frames, so placement hover freezes while this is set (the same
 * behaviour as mouse navigation, where picking is paused and no new hover
 * arrives). The preview stays where it was; it re-routes once navigation stops.
 *
 * `SceneCanvas` sets this from its `spaceMouseNavigationActive` state.
 */
let navigationActive = false;
const listeners = new Set<() => void>();

export function setSupportNavigationActive(active: boolean): void {
  if (active === navigationActive) return;
  navigationActive = active;
  for (const listener of listeners) listener();
}

export function getSupportNavigationActive(): boolean {
  return navigationActive;
}

export function subscribeToSupportNavigationActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

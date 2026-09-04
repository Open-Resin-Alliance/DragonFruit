/**
 * The gizmo drag that is running right now, and how to call it off.
 *
 * A gesture on a gizmo handle owns the pointer, so anything else that reacts to
 * a key while it runs is reacting in the middle of someone else's edit. Escape
 * is the case that matters: unhandled, it reached the canvas and deselected the
 * model, which unmounted the tool and the gizmo mid-drag and left the drag never
 * ended — the readout stuck to the cursor, the session still flagged as
 * dragging, the whole tool unusable. Escape now finds the drag here and cancels
 * it, and the canvas leaves the selection alone.
 *
 * Module-level rather than context: the canvas reads it from a hotkey
 * subscription outside the R3F tree, and there is only ever one pointer.
 *
 * "Cancel" means put back what the gesture changed and end it. It does NOT mean
 * undo whatever came before, so a cancelled drag leaves the scene exactly as the
 * grab found it.
 */

export type GizmoDragCancel = () => void;

let activeCancel: GizmoDragCancel | null = null;

/**
 * Claim the slot for a starting drag. The returned function releases it, and is
 * safe to call from an unmount cleanup or twice over.
 */
export function beginGizmoDrag(cancel: GizmoDragCancel): () => void {
  activeCancel = cancel;
  return () => {
    if (activeCancel === cancel) activeCancel = null;
  };
}

/** True while a gizmo handle is being dragged. */
export function isGizmoDragActive(): boolean {
  return activeCancel !== null;
}

/**
 * Call off the running drag, if there is one. Returns whether there was, so the
 * caller can tell "I handled it" from "nothing to handle" and act accordingly.
 */
export function cancelActiveGizmoDrag(): boolean {
  const cancel = activeCancel;
  if (!cancel) return false;
  activeCancel = null;
  cancel();
  return true;
}

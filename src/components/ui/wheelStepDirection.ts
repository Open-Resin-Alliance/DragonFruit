/**
 * Which way a wheel event should step a number field, read from the dominant
 * axis rather than from `deltaY` alone.
 *
 * With Shift held, a mouse wheel is delivered as horizontal scroll — `deltaY`
 * arrives as 0 and the movement lands in `deltaX`. A trackpad keeps reporting
 * both axes, so a `deltaY`-only reading works there and silently ignores the
 * wheel, which is exactly the Shift+scroll gate in `ScrollLockedInputs`.
 *
 * This is not a macOS quirk: the swap happens inside the browser engine, so
 * Chrome, Edge and Firefox do it on Windows and Linux too. It applies to wheels
 * only — trackpads already have a horizontal gesture, so they are left alone.
 * Reading the dominant axis covers every combination without sniffing either
 * the platform or the device.
 *
 * Returns 0 when the event carries no usable movement.
 */
export function wheelStepDirection(event: { deltaX: number; deltaY: number }): 1 | -1 | 0 {
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (!Number.isFinite(delta) || delta === 0) return 0;
  return delta < 0 ? 1 : -1;
}

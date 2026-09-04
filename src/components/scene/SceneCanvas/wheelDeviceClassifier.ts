/**
 * What produced a wheel event — or an honest admission that we cannot tell.
 *
 * 'unknown' is the point of this module. The previous version had no such
 * verdict: when the evidence ran out it guessed, and a wrong guess stuck.
 */
export type WheelDevice = 'wheel' | 'trackpad' | 'unknown';

export type WheelSample = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  /** Legacy Blink/WebKit field. Absent in Firefox; quantised for wheels. */
  wheelDeltaY?: number;
};

/**
 * Tells a mouse wheel apart from a trackpad two-finger scroll, as far as the
 * DOM allows — which is not very far, and the API offers nothing better: a
 * `wheel` event carries no device identity. (A 3D mouse is a different story;
 * it arrives through the Gamepad API, which does name its device.)
 *
 * Signals, strongest first:
 *
 * - **`deltaMode !== 0`.** Line/page deltas only ever come from a wheel.
 * - **`ctrlKey`.** The pinch gesture Blink synthesizes. NOTE: WebKit uses
 *   proprietary GestureEvents for pinch instead, so this may never fire inside
 *   a WKWebView — pinch handling there needs `gesturestart`/`gesturechange`,
 *   which this app does not implement yet.
 * - **Movement on both axes.** A wheel turns in one axis per event; a tilt
 *   wheel moves in the other, never in both. A trackpad is a 2D surface, so a
 *   drag leaks into the off-axis. Checked per event *and* across the gesture,
 *   since the leak may show up only in some frames.
 * Fractional deltas used to count as trackpad evidence here, on the assumption
 * that wheel notches are whole numbers. They are not: with Windows display
 * scaling, Chrome divides the notch through and a G502 reports deltaY
 * 111.11111405455044 (120 * 10/9) forever. That rule classified plain mice as
 * trackpads and made them pan instead of zoom. It also bought nothing — in the
 * macOS captures trackpad *scrolling* is whole-numbered too, and the one
 * fractional trackpad case, pinch, is already caught by ctrlKey.
 * - **Quantised `wheelDeltaY`.** Multiples of 120 are wheel notches. Only
 *   trusted when two consecutive events agree, because macOS acceleration can
 *   land a trackpad delta on a multiple by chance.
 *
 * What is deliberately NOT used: the *size* of a delta, and the *cadence* of
 * the event stream. Both describe the platform's scroll pipeline, not the
 * device. macOS accelerates the wheel and smooths it into a stream, so a hard
 * spin arrives at 16-24ms per event with deltas from 13 to 514 — frame-rate
 * cadence and trackpad-sized numbers, from a mouse. That is the OS itself, not
 * a remapper: the captures in the fixtures were taken with LinearMouse both
 * running and quit, and the numbers are the same. A remapper (LinearMouse, Mos,
 * Logi Options+) can rewrite them further, which only makes the point stronger.
 *
 * A verdict is sticky for the length of a gesture, and survives between
 * gestures for a short while: the device does not change between two flicks a
 * moment apart, but it may well have changed a minute later. That TTL is the
 * self-healing property the previous version lacked.
 */

const GESTURE_GAP_MS = 200;
/**
 * How long a verdict outlives its gesture. Long enough to carry a series of
 * flicks; short enough that a wrong call cannot outlive the session.
 */
const VERDICT_TTL_MS = 1500;
/** One wheel notch in Blink/WebKit's legacy units. */
const WHEEL_DELTA_QUANTUM = 120;
/**
 * How many events into a gesture the inherited verdict still applies.
 *
 * A trackpad gives itself away almost immediately — in the captures the
 * off-axis leak lands on the second event. A wheel never gives itself away at
 * all, so a gesture that is still silent after a few events is treated as
 * unproven rather than as more of whatever came before. This is what stops a
 * hard wheel spin right after a trackpad drag from panning for a second and a
 * half: it caps the damage at the first few frames.
 */
const INHERIT_MAX_EVENTS = 3;

function isQuantisedWheelDelta(sample: WheelSample): boolean {
  const raw = sample.wheelDeltaY;
  if (typeof raw !== 'number' || raw === 0) return false;
  if (!Number.isInteger(raw)) return false;
  return Math.abs(raw) % WHEEL_DELTA_QUANTUM === 0;
}

export function createWheelDeviceClassifier() {
  let lastEventTime = Number.NEGATIVE_INFINITY;

  // Per gesture.
  let gestureVerdict: WheelDevice = 'unknown';
  let gestureSawX = false;
  let gestureSawY = false;

  // Rolling, across gesture boundaries on purpose: slow wheel notches are one
  // gesture each, so a per-gesture memory could never see two of them agree.
  let previousWasQuantised = false;
  let gestureEventCount = 0;

  // Across gestures, until the TTL runs out.
  let recentVerdict: WheelDevice = 'unknown';
  let recentVerdictTime = Number.NEGATIVE_INFINITY;

  // Both wheel handlers see the same event; classifying it twice would count
  // the same evidence twice.
  let memoSample: WheelSample | null = null;
  let memoVerdict: WheelDevice = 'unknown';

  /**
   * A gesture that was a single event, with nothing pointing at a trackpad, was
   * a wheel notch: a trackpad streams frames for as long as fingers move and
   * cannot produce a one-event gesture. Recorded as evidence for what comes
   * next, so a wheel used right after the trackpad stops inheriting its verdict.
   */
  function finishGesture(now: number): void {
    if (gestureEventCount === 1 && gestureVerdict === 'unknown') {
      recentVerdict = 'wheel';
      recentVerdictTime = now;
    }
  }

  function startGesture(): void {
    gestureVerdict = 'unknown';
    gestureSawX = false;
    gestureSawY = false;
    gestureEventCount = 0;
  }

  function evidenceFor(sample: WheelSample): WheelDevice {
    if (sample.deltaMode !== 0) return 'wheel';
    if (sample.ctrlKey) return 'trackpad';
    if (sample.deltaX !== 0 && sample.deltaY !== 0) return 'trackpad';
    // Both axes have moved at some point in this gesture: a drag, not a turn.
    if (gestureSawX && gestureSawY) return 'trackpad';
    if (isQuantisedWheelDelta(sample) && previousWasQuantised) return 'wheel';
    return 'unknown';
  }

  return {
    classify(sample: WheelSample, now: number): WheelDevice {
      if (sample === memoSample) return memoVerdict;

      if (now - lastEventTime > GESTURE_GAP_MS) {
        finishGesture(lastEventTime);
        startGesture();
      }
      lastEventTime = now;
      gestureEventCount += 1;

      if (sample.deltaX !== 0) gestureSawX = true;
      if (sample.deltaY !== 0) gestureSawY = true;

      const evidence = evidenceFor(sample);
      previousWasQuantised = isQuantisedWheelDelta(sample);

      if (evidence !== 'unknown' && gestureVerdict === 'unknown') {
        gestureVerdict = evidence;
      }

      // Refreshed on every event, not just on the first one: the TTL has to
      // measure from the last time we saw this device, or a long drag would go
      // stale while the fingers are still moving.
      if (gestureVerdict !== 'unknown') {
        recentVerdict = gestureVerdict;
        recentVerdictTime = now;
      }

      let verdict = gestureVerdict;
      const mayInherit = gestureEventCount <= INHERIT_MAX_EVENTS;
      if (verdict === 'unknown' && mayInherit && now - recentVerdictTime <= VERDICT_TTL_MS) {
        verdict = recentVerdict;
      }

      memoSample = sample;
      memoVerdict = verdict;
      return verdict;
    },

    /** Test seam — the handlers never need it. */
    reset(): void {
      lastEventTime = Number.NEGATIVE_INFINITY;
      recentVerdict = 'unknown';
      recentVerdictTime = Number.NEGATIVE_INFINITY;
      memoSample = null;
      memoVerdict = 'unknown';
      startGesture();
    },
  };
}

export type WheelDeviceClassifier = ReturnType<typeof createWheelDeviceClassifier>;

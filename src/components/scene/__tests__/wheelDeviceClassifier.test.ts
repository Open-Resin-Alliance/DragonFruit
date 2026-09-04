import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWheelDeviceClassifier,
  type WheelDevice,
  type WheelSample,
} from '../SceneCanvas/wheelDeviceClassifier';
import {
  MOUSE_FAST,
  MOUSE_SLOW,
  MOUSE_W10_FAST,
  MOUSE_W10_SLOW,
  TRACKPAD_PINCH,
  TRACKPAD_SCROLL,
} from './wheelCaptures.fixture';

/** Mirrors INHERIT_MAX_EVENTS in the classifier. */
const INHERIT_MAX_EVENTS_IN_TEST = 3;

/**
 * A row as captured in the browser by the `wcap` console helper:
 *   { t, dx, dy, mode, wdy, ctrl }
 *
 * Real captures from real hardware drop in here as fixtures; the synthetic
 * sequences below stand in until then and are labelled as such.
 */
type CaptureRow = { t: number; dx: number; dy: number; mode?: number; wdy?: number; ctrl?: boolean };

function replay(rows: CaptureRow[]): WheelDevice[] {
  const classifier = createWheelDeviceClassifier();
  return rows.map((row) => {
    const sample: WheelSample = {
      deltaX: row.dx,
      deltaY: row.dy,
      deltaMode: row.mode ?? 0,
      ctrlKey: row.ctrl ?? false,
      wheelDeltaY: row.wdy,
    };
    return classifier.classify(sample, row.t);
  });
}

test('line-mode deltas are a wheel', () => {
  assert.deepEqual(replay([{ t: 0, dx: 0, dy: 3, mode: 1 }]), ['wheel']);
});

test('ctrlKey pinch is a trackpad', () => {
  assert.deepEqual(replay([{ t: 0, dx: 0, dy: 40, ctrl: true }]), ['trackpad']);
});

test('both axes in one event is a trackpad', () => {
  assert.deepEqual(replay([{ t: 0, dx: 3, dy: 12 }]), ['trackpad']);
});

test('off-axis leak anywhere in the gesture makes it a drag', () => {
  // The user's insight: a finger drag is never perfectly straight, so the
  // off-axis shows up sooner or later even if the first frames are clean.
  const verdicts = replay([
    { t: 0, dx: 0, dy: 40 },
    { t: 16, dx: 0, dy: 60 },
    { t: 32, dx: -1, dy: 60 },
    { t: 48, dx: 0, dy: 50 },
  ]);
  assert.deepEqual(verdicts, ['unknown', 'unknown', 'trackpad', 'trackpad']);
});

test('magnitude and cadence are ignored', () => {
  // A slow 16px notch and a hard 150px flick at frame rate: the two cases the
  // previous heuristic got backwards. Neither carries device evidence now.
  assert.deepEqual(replay([{ t: 0, dx: 0, dy: 16 }]), ['unknown']);
  assert.deepEqual(
    replay([
      { t: 0, dx: 0, dy: 150 },
      { t: 12, dx: 0, dy: 140 },
      { t: 24, dx: 0, dy: 130 },
    ]),
    ['unknown', 'unknown', 'unknown'],
  );
});

test('quantised wheelDelta needs two events to agree', () => {
  // SYNTHETIC pending real captures: Blink reports ±120 per notch.
  const verdicts = replay([
    { t: 0, dx: 0, dy: -100, wdy: 120 },
    { t: 300, dx: 0, dy: -100, wdy: 120 },
  ]);
  assert.deepEqual(verdicts, ['unknown', 'wheel'], 'one quantised event alone proves nothing');
});

test('a lone quantised event inside a trackpad gesture does not flip it', () => {
  const verdicts = replay([
    { t: 0, dx: 2, dy: 30, wdy: 90 },
    { t: 16, dx: 0, dy: 40, wdy: 120 },
    { t: 32, dx: 0, dy: 40, wdy: 120 },
  ]);
  assert.deepEqual(verdicts, ['trackpad', 'trackpad', 'trackpad'], 'the gesture verdict is sticky');
});

test('a verdict carries across nearby gestures and then expires', () => {
  const classifier = createWheelDeviceClassifier();
  const at = (t: number, sample: Partial<WheelSample>) =>
    classifier.classify({ deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, ...sample }, t);

  assert.equal(at(0, { deltaX: 3, deltaY: 12 }), 'trackpad');
  // A straight flick a moment later: same device, no fresh evidence.
  assert.equal(at(600, { deltaX: 0, deltaY: 40 }), 'trackpad');
  // Long after, the classifier stops claiming to know.
  assert.equal(at(9000, { deltaX: 0, deltaY: 40 }), 'unknown');
});

test('a wrong call cannot outlive the TTL', () => {
  // The failure that shipped: once the old classifier said "trackpad" it never
  // recovered, and the wheel stopped zooming for the rest of the session.
  const classifier = createWheelDeviceClassifier();
  const at = (t: number, sample: Partial<WheelSample>) =>
    classifier.classify({ deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, ...sample }, t);

  at(0, { deltaX: 1, deltaY: 20 });
  assert.equal(at(5000, {}), 'unknown', 'silence must fall back to unknown, never to a stale guess');
});

test('captured trackpad pinch: trackpad from the first event', () => {
  const verdicts = replay(
    TRACKPAD_PINCH.map(([t, dx, dy, wdy]) => ({ t, dx, dy, wdy, ctrl: true })),
  );
  assert.ok(
    verdicts.every((verdict) => verdict === 'trackpad'),
    `expected every pinch event to read as trackpad, got ${JSON.stringify([...new Set(verdicts)])}`,
  );
});

test('captured trackpad scroll: trackpad from the second event onwards', () => {
  const verdicts = replay(TRACKPAD_SCROLL.map(([t, dx, dy, wdy]) => ({ t, dx, dy, wdy })));

  // The first event of the gesture is dx: 0, dy: -1 — indistinguishable from a
  // wheel notch, so the classifier says so instead of guessing. This is the
  // one-frame jump felt at the start of a drag.
  assert.equal(verdicts[0], 'unknown');
  assert.equal(verdicts[1], 'trackpad', 'the off-axis leak lands on the second event');
  assert.ok(
    verdicts.slice(1).every((verdict) => verdict === 'trackpad'),
    'the rest of the gesture must stay trackpad, including the frames where dx returns to 0',
  );
});

const mouseFastRows = MOUSE_FAST.map(([t, dy]) => ({ t, dx: 0, dy, wdy: dy * -3 }));

test('captured mouse wheel never reads as a trackpad', () => {
  for (const [label, rows] of [
    ['slow', MOUSE_SLOW.map(([t, dx, dy, wdy]) => ({ t, dx, dy, wdy }))],
    ['fast', mouseFastRows],
  ] as const) {
    const verdicts = replay(rows);
    assert.ok(
      verdicts.every((verdict) => verdict !== 'trackpad'),
      `${label} wheel produced a trackpad verdict, which would pan instead of zoom`,
    );
  }
});

test('a hard wheel spin right after a trackpad drag stops panning within a few frames', () => {
  // The fast-spin capture runs at 16-24ms per event — trackpad cadence, from a
  // mouse — so nothing but the inheritance cap keeps it from riding the
  // previous verdict for the whole TTL.
  const trackpadEnd = TRACKPAD_SCROLL.at(-1)![0];
  const spinStart = mouseFastRows[0].t;
  const shifted = mouseFastRows.map((row) => ({ ...row, t: row.t - spinStart + trackpadEnd + 300 }));

  const verdicts = replay([
    ...TRACKPAD_SCROLL.map(([t, dx, dy, wdy]) => ({ t, dx, dy, wdy })),
    ...shifted,
  ]).slice(TRACKPAD_SCROLL.length);

  assert.ok(
    verdicts.slice(INHERIT_MAX_EVENTS_IN_TEST).every((verdict) => verdict !== 'trackpad'),
    'the spin must stop inheriting the trackpad verdict once the gesture stays silent',
  );
});

test('captured Windows wheel never reads as a trackpad', () => {
  // Reported in the wild: a G502 on Windows panned instead of zooming, because
  // display scaling makes every notch fractional (111.11111405455044).
  for (const [label, rows] of [
    ['slow', MOUSE_W10_SLOW],
    ['fast', MOUSE_W10_FAST],
  ] as const) {
    const verdicts = replay(rows.map(([t, dy, wdy]) => ({ t, dx: 0, dy, wdy })));
    assert.ok(
      verdicts.every((verdict) => verdict !== 'trackpad'),
      `${label} Windows wheel produced a trackpad verdict, which would pan instead of zoom`,
    );
  }
});

test('a fractional delta on its own proves nothing', () => {
  assert.deepEqual(replay([{ t: 0, dx: 0, dy: -12.5 }]), ['unknown']);
});

test('the same event object classifies once', () => {
  const classifier = createWheelDeviceClassifier();
  const shared: WheelSample = { deltaX: 3, deltaY: 12, deltaMode: 0, ctrlKey: false };
  assert.equal(classifier.classify(shared, 1000), 'trackpad');
  assert.equal(classifier.classify(shared, 1000), 'trackpad');

  // Both handlers looked at it; the gesture state must have advanced only once.
  assert.equal(
    classifier.classify({ deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false }, 9000),
    'unknown',
  );
});

/**
 * Frame times while the camera moves — the number behind "orbiting feels
 * sluggish".
 *
 * The stall detector only speaks up past half a second. A drag that runs at
 * 20 fps, or that hitches every few frames, never gets there and is still what
 * a user calls slow. This collects the gaps between animation frames for the
 * length of one camera gesture and writes one line when it ends: how long it
 * lasted, the frame rate, the median and 95th-percentile frame, and how many
 * frames went past 50 and 100 ms. Long gaps with a cheap render point at the
 * main thread; the canvas size on the same line points at the GPU.
 *
 * It listens to the `picking-*-change` events the scene canvas already emits
 * while the camera moves, so nothing at the call sites changes. The frame loop
 * only runs during a gesture.
 */

import { describeSceneCanvas } from './canvasBuffer';
import { ms, type PerfLogger } from './perfLog';
import { summarizeFrameGaps } from './perfStats';

type GestureKind = 'orbit' | 'pan' | 'zoom';

const CHANGE_EVENTS: Record<string, GestureKind> = {
    'picking-orbit-change': 'orbit',
    'picking-pan-change': 'pan',
    'picking-zoom-change': 'zoom',
};

/** No camera change for this long ends the gesture. */
const IDLE_END_MS = 250;
/** Shorter gestures are clicks and nudges, too few frames to say anything. */
const MIN_GESTURE_MS = 400;
/** Beyond this a single gap is the window hidden or the machine asleep. */
const SUSPENSION_MS = 5_000;

export function startCameraFrameTiming(logger: PerfLogger): () => void {
    if (typeof window === 'undefined') return () => { };

    let active = false;
    let startedAt = 0;
    let lastChangeAt = 0;
    let lastFrameAt = 0;
    let frameHandle = 0;
    let gaps: number[] = [];
    const kinds = new Set<GestureKind>();

    const finish = (endedAt: number) => {
        active = false;
        window.cancelAnimationFrame(frameHandle);
        const durationMs = endedAt - startedAt;
        if (durationMs < MIN_GESTURE_MS || gaps.length < 5) return;

        const summary = summarizeFrameGaps(gaps);
        logger.info(
            `[perf:camera] ${[...kinds].join('+')} ${ms(durationMs)} `
            + `fps=${summary.fps.toFixed(0)} p50=${ms(summary.p50Ms)} p95=${ms(summary.p95Ms)} `
            + `max=${ms(summary.maxMs)} >50ms=${summary.over50} >100ms=${summary.over100} `
            + `frames=${summary.frames} ${describeSceneCanvas() ?? 'no canvas'}`,
        );
    };

    const onFrame = (now: number) => {
        if (!active) return;
        const gap = now - lastFrameAt;
        lastFrameAt = now;
        if (gap > SUSPENSION_MS || document.hidden) {
            // Throw the gesture away rather than report a sleep as a stutter.
            active = false;
            return;
        }
        gaps.push(gap);
        if (now - lastChangeAt > IDLE_END_MS) {
            finish(lastChangeAt);
            return;
        }
        frameHandle = window.requestAnimationFrame(onFrame);
    };

    const onChange = (event: Event) => {
        const now = performance.now();
        kinds.add(CHANGE_EVENTS[event.type]);
        lastChangeAt = now;
        if (active) return;
        active = true;
        startedAt = now;
        lastFrameAt = now;
        gaps = [];
        kinds.clear();
        kinds.add(CHANGE_EVENTS[event.type]);
        frameHandle = window.requestAnimationFrame(onFrame);
    };

    const types = Object.keys(CHANGE_EVENTS);
    for (const type of types) window.addEventListener(type, onChange);
    return () => {
        active = false;
        window.cancelAnimationFrame(frameHandle);
        for (const type of types) window.removeEventListener(type, onChange);
    };
}

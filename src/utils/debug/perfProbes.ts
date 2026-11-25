/**
 * The always-on performance probes, started together by `AppLogger`. Each one
 * writes a line only when there is something to report, so they can ship in
 * every build. See `docs/dev/performance-debugging.md` for how to read them.
 */

import { startCameraFrameTiming } from './cameraFrameTiming';
import { startCanvasBufferLog } from './canvasBuffer';
import { createPerfLogger } from './perfLog';
import { startReactCommitWatch } from './reactCommitWatch';
import { startSlowInteractionLog } from './slowInteractions';

export function startPerfProbes(): () => void {
    const logger = createPerfLogger();
    const stops = [
        startCameraFrameTiming(logger),
        startCanvasBufferLog(logger),
        startReactCommitWatch(logger),
        startSlowInteractionLog(logger),
    ];
    return () => {
        for (const stop of stops) stop();
    };
}

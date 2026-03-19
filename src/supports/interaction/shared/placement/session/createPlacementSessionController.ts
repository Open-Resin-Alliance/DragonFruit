import type { Vec3 } from '@/supports/types';
import type {
    PlacementSessionStage,
    PlacementSessionState,
} from './placementSessionTypes';
import { EMPTY_PLACEMENT_SESSION_STATE } from './placementSessionTypes';

export interface PlacementSessionController {
    getState: () => PlacementSessionState;
    setHotkeyActive: (active: boolean) => void;
    setHoverPoint: (point: Vec3 | null) => void;
    start: (point: Vec3, normal: Vec3) => void;
    advanceTo: (stage: PlacementSessionStage) => void;
    finalize: () => void;
    cancel: () => void;
    reset: () => void;
}

export function createPlacementSessionController(
    read: () => PlacementSessionState,
    write: (next: PlacementSessionState) => void,
): PlacementSessionController {
    return {
        getState: read,

        setHotkeyActive(active: boolean) {
            const current = read();
            if (current.hotkeyActive === active) return;
            write({
                ...current,
                hotkeyActive: active,
                justFinalized: false,
            });
        },

        setHoverPoint(point: Vec3 | null) {
            const current = read();
            write({
                ...current,
                hoverPoint: point,
                previewVisible: point !== null || current.previewVisible,
            });
        },

        start(point: Vec3, normal: Vec3) {
            const current = read();
            write({
                ...current,
                stage: 'primed',
                startPoint: point,
                startNormal: normal,
                previewVisible: true,
                justFinalized: false,
            });
        },

        advanceTo(stage: PlacementSessionStage) {
            const current = read();
            write({
                ...current,
                stage,
            });
        },

        finalize() {
            const current = read();
            write({
                ...current,
                stage: 'finalized',
                previewVisible: false,
                hoverPoint: null,
                justFinalized: true,
            });
        },

        cancel() {
            const current = read();
            write({
                ...current,
                stage: 'cancelled',
                previewVisible: false,
                hoverPoint: null,
                justFinalized: false,
            });
        },

        reset() {
            const current = read();
            write({
                ...EMPTY_PLACEMENT_SESSION_STATE,
                hotkeyActive: current.hotkeyActive,
            });
        },
    };
}

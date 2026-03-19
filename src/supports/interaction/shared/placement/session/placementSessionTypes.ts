import type { Vec3 } from '@/supports/types';

export type PlacementSessionStage =
    | 'idle'
    | 'primed'
    | 'awaitingSecondAction'
    | 'finalized'
    | 'cancelled';

export interface PlacementSessionState {
    stage: PlacementSessionStage;
    hotkeyActive: boolean;
    startPoint: Vec3 | null;
    startNormal: Vec3 | null;
    hoverPoint: Vec3 | null;
    previewVisible: boolean;
    justFinalized: boolean;
}

export const EMPTY_PLACEMENT_SESSION_STATE: PlacementSessionState = {
    stage: 'idle',
    hotkeyActive: false,
    startPoint: null,
    startNormal: null,
    hoverPoint: null,
    previewVisible: false,
    justFinalized: false,
};

export const GRID_HOME_FOCUS_STATE = {
    position: [22.3, -41.73, 25.19] as [number, number, number],
    target: [-1.27, 3.34, 4.56] as [number, number, number],
    zoom: 11.98
};

export function getGridTargetFocusState(key: string | null) {
    // For now, grid doesn't have specific focus states for settings, just returns home.
    return GRID_HOME_FOCUS_STATE;
}

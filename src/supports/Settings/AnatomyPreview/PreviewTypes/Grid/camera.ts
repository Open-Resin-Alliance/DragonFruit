export const GRID_HOME_FOCUS_STATE = {
    // Slightly raised framing target so the grid preview content sits lower in the viewport.
    position: [22.3, -41.73, 26.8] as [number, number, number],
    target: [-1.27, 3.34, 0.0] as [number, number, number],
    zoom: 11.98
};

export function getGridTargetFocusState(key: string | null) {
    // For now, grid doesn't have specific focus states for settings, just returns home.
    return GRID_HOME_FOCUS_STATE;
}

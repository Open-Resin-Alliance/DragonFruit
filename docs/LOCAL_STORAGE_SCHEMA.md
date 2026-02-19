# Local Storage Schema

This document serves as the single source of truth for all data persisted in `localStorage`.
Use this to identify what data needs to be migrated to a backend filesystem or database in the future.

## Keys

### `support-settings`

- **Description**: Stores user preferences for support generation (tips, shafts, grid settings, etc.).
- **Location**: `src/supports/Settings/state.ts`
- **Schema**: `SupportSettings` object (see `src/supports/Settings/types.ts`).
- **Example**:
  ```json
  {
    "tip": { "topDiameter": 0.4, ... },
    "grid": { "enabled": true, "spacingMm": 2.0, ... }
  }
  ```

### `app-hotkeys-config`

- **Description**: Stores user customizations for application hotkeys. Keys present here override the defaults.
- **Location**: `src/hotkeys/HotkeyContext.tsx`
- **Schema**: `HotkeyConfig` object (see `src/hotkeys/hotkeyConfig.ts`).
- **Example**:
  ```json
  {
    "CAMERA": {
      "FOCUS_PICK": {
        "key": "g",
        "description": "Press to refocus..."
      }
    }
  }
  ```

### `app-theme-preference`

- **Description**: Stores the user's selected application theme preference.
- **Location**: `src/components/layout/TopBar.tsx`, `src/components/settings/SettingsModal.tsx`
- **Schema**: string enum: `'system' | 'dark' | 'light'`
- **Example**:
  ```json
  "dark"
  ```

### `app-theme-colors`

- **Description**: Stores customizable UI color overrides used by theme settings.
- **Location**: `src/components/settings/themeCustomizations.ts`, `src/components/settings/SettingsModal.tsx`
- **Schema**: object with hex color values.
- **Example**:
  ```json
  {
    "accent": "#4f8cff",
    "sceneGradientRadial": "#ff37aa",
    "sceneGradientLinearStart": "#ff37aa",
    "sceneGradientLinearMid": "#6f33ff",
    "topbarAccent": "#4f8cff",
    "surface1": "#151c25",
    "surface2": "#1b2430",
    "textStrong": "#f3f7ff",
    "textMuted": "#9eacbf",
    "borderSubtle": "#233040"
  }
  ```

### `app-theme-preset`

- **Description**: Stores the selected built-in UI theme preset.
- **Location**: `src/components/settings/themeCustomizations.ts`, `src/components/settings/SettingsModal.tsx`, `src/components/settings/UISettingsTab.tsx`
- **Schema**: string enum. Current supported value: `'dragonfruit-dark'`.
- **Example**:
  ```json
  "dragonfruit-dark"
  ```

### `lumenslicer:floating-panel-layout:v4`

- **Description**: Stores floating panel positions for draggable panel layout memory.
- **Location**: `src/components/layout/FloatingPanelStack.tsx`
- **Schema**: object with `positions` map keyed by panel ID to `{ x: number, y: number }`.
- **Example**:
  ```json
  {
    "positions": {
      "panel-0": { "x": 12, "y": 12 },
      "prepare-transform-controls": { "x": 12, "y": 348 }
    }
  }
  ```

### `app-floating-layout-persistence`

- **Description**: Stores whether floating panel positions should persist between sessions.
- **Location**: `src/components/layout/floatingLayoutPreferences.ts`, `src/components/layout/FloatingPanelStack.tsx`, `src/components/settings/GeneralSettingsTab.tsx`
- **Schema**: string boolean (`'true' | 'false'`). Missing key defaults to `'true'`.
- **Example**:
  ```json
  "true"
  ```

### `app-recent-opened-files`

- **Description**: Stores a rolling FIFO queue of recently opened mesh/scene files shown in the empty-scene dialog.
- **Location**: `src/features/scene/useSceneCollectionManager.ts`, `src/components/layout/EmptySceneState.tsx`
- **Schema**: array of entries `{ id: string; name: string; kind: 'mesh' | 'scene'; sizeBytes?: number; openedAt: number }`.
- **Notes**: queue is capped at 10 entries and evicts oldest records first; opening/reopening a file already in the queue reuses its entry and promotes it to newest (no duplicates); file payloads used for "reopen recent" are cached in IndexedDB (`dragonfruit-recent-files` / `files` store) keyed by `id`.
- **Example**:
  ```json
  [
    {
      "id": "d4f4b7e6-3e56-4a68-9b89-6cf8f5f9c0b7",
      "name": "part_A.stl",
      "kind": "mesh",
      "sizeBytes": 512034,
      "openedAt": 1768574400000
    },
    {
      "id": "4f2b20d0-798b-4f0e-9a89-977fb3228581",
      "name": "scene.lys",
      "kind": "scene",
      "openedAt": 1768573700000
    }
  ]
  ```

### `app-3d-view-settings`

- **Description**: Stores cross-workspace 3D view debug settings for build volume bounds, origin placement, max Z, screen resolution hints, and out-of-bounds warnings.
- **Location**: `src/components/settings/view3dPreferences.ts`, `src/components/settings/WorkspacesSettingsTab.tsx`, `src/components/scene/SceneCanvas/SceneCanvas.tsx`
- **Schema**: `{ enabled: boolean; widthMm: number; depthMm: number; maxZMm: number; originMode: 'center' | 'front_left'; screenWidthPx: number; screenHeightPx: number; showViolationWarning: boolean }`
- **Example**:
  ```json
  {
    "enabled": true,
    "widthMm": 218,
    "depthMm": 123,
    "maxZMm": 250,
    "originMode": "front_left",
    "screenWidthPx": 2560,
    "screenHeightPx": 1440,
    "showViolationWarning": true
  }
  ```

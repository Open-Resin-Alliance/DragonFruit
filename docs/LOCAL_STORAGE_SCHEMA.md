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

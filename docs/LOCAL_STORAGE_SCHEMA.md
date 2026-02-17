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

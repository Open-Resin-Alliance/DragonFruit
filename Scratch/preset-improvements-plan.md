# Dev Plan: Support Preset System Improvements

## Goal
Improve the support presets system by increasing the number of presets, updating the UI layout, and enabling user-customizable presets with specific setting exclusions.

## Requirements
1.  **Expand Presets:** Increase available presets from 3 to 6.
2.  **UI Redesign:** Change the preset selector layout from a single column (stacked) to a 2-column grid (rows of 2).
3.  **Save Functionality:** Allow users to save current settings to a preset.
4.  **Exclusions:** The following settings must NOT be saved to the preset (or applied from the preset):
    -   **Raft:** Managed separately (already isolated in `RaftState.ts`).
    -   **Grid:** `grid` settings in `SupportSettings`.
    -   **Cone Control Angle:** Specific tip settings (`coneAngleMode`, `adaptiveConeAngleOffsetDeg`, `coneAngleDeg`).

## Architecture & Code Changes

### 1. `src/supports/Settings/presets.ts`

-   **Update Preset Definitions:** 
    -   Add 3 new placeholders or default presets (e.g., "Custom 1", "Custom 2", "Custom 3") to reach 6 total.
    -   Ensure `allIds` list is updated.

-   **Implement `savePreset(id: string)`:**
    -   Create a helper function to merge current settings into a preset.
    -   **Exclusion Logic:**
        -   Get `currentSettings` from `state.ts`.
        -   Create a `newSettings` object based on `currentSettings`.
        -   **Restore Excluded Values:** Overwrite the `grid` and `cone` related fields in `newSettings` with the values *currently stored in the target preset* (or defaults if we want them static, but likely we just want to avoid overwriting the preset's existing values for these fields, OR we want the preset to *not affect* them when loaded).
        -   *Clarification:* if the preset shouldn't *include* them, it means when we apply the preset, we shouldn't change the current values of these fields. And when we save, we shouldn't overwrite the preset's values with current ones (effectively keeping them decoupled).
    -   Update the `presets` store with the modified preset.
    -   Persist to internal storage if needed (or just in-memory for this session? User said "saveable", usually implies persistence. I will add local storage persistence for presets in a later step if requested, but for now I'll implement the state update). *Self-correction: The existing `SupportSidebar` already has `saveSettingsToLocalStorage`. I should probably ensure presets are also persisted or at least dynamic.* I will treat them as mutable runtime state for this task unless I see existing preset persistence logic (I didn't see `loadPresets` logic in `presets.ts`, only static consts. I'll stick to in-memory modification first, but note that a full feature would need persistence).

-   **Update `setActivePreset(id: string)`:**
    -   Ensure that when a preset is applied, it *excludes* applying the Grid and Cone Control Angle settings.
    -   Current logic:
        ```typescript
        setSettings({
            ...preset.settings,
            grid: {
                ...preset.settings.grid,
                enabled: current.grid.enabled, 
            },
        });
        ```
    -   New Logic: ensure `tip.coneAngleMode` etc. are also preserved from `current` settings, not taken from `preset`.

### 2. `src/supports/Settings/components/PresetSelector.tsx`

-   **Layout Update:**
    -   Change container class to `grid grid-cols-2 gap-1` (instead of `space-y-1`).
    -   Adjust `PresetCard` usage if needed.

-   **Save Interaction:**
    -   Add a "Save" action. This could be a context menu or a small button on the card.
    -   Given "mobile-ish" or tight UI, a long-press or a small "floppy disk" icon on the active preset might work.
    -   Or, simpler: Add a global "Save to Active Preset" button in the sidebar? 
    -   *Decision:* Add a small button on each preset card (visible on hover or always for active) to "Save Current to This Slot".

### 3. `src/supports/Settings/components/PresetCard.tsx` (if exists) or Inline

-   You might need to modify `PresetCard` to accept a `onSave` prop and render the save button.

## Step-by-Step Implementation

1.  **Refactor `presets.ts`:**
    -   Add `saveToPreset(id)`.
    -   Modify `setActivePreset` to respect exclusions.
    -   Add the 3 new presets.
2.  **Refactor `PresetSelector.tsx`:**
    -   Implement grid layout.
    -   Add "Save" buttons/icons to cards.
3.  **Verification:**
    -   Test changing settings -> Save to Preset A.
    -   Change settings again.
    -   Load Preset A -> Verify settings restored (except Exclusions).
    -   Verify Grid/Raft/Cone Angle did NOT change when loading Preset A.

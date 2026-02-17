# 7 Hotkeys

## Purpose
Centralize hotkey defaults in a compact, readable format and note that all non-universal hotkeys are intended to be user-remappable in a future settings system.

The authoritative defaults live in `src/hotkeys/hotkeyConfig.ts`.

## Universal hotkeys (not intended to be remappable)

These are hard-coded “system standard” behaviors.

| Hotkey | Action | Implemented in | Mounted from |
| --- | --- | --- | --- |
| Delete / Backspace | Delete selected item | `src/features/delete/useDeleteHotkey.ts` | `src/app/page.tsx` |
| Ctrl/Cmd+Z | Undo | `src/hotkeys/useUndoRedoHotkeys.ts` | `src/app/page.tsx` |
| Ctrl/Cmd+Shift+Z | Redo | `src/hotkeys/useUndoRedoHotkeys.ts` | `src/app/page.tsx` |

## Default keybindings (intended to be remappable later)

These are defaults only. Remapping UI/storage is not implemented yet.

| Feature | Default hotkey | Action / Mode | Implemented in |
| --- | --- | --- | --- |
| Joint creation | Hold `J` | Enter/exit Joint Creation Mode | `src/supports/SupportPrimitives/Joint/useJointCreationHotkey.ts` |
| Curve mode | Hold `C` | Enter/exit Curve Mode; on key release toggles curve on selected segment | `src/supports/Curves/useCurveHotkey.ts` |
| Branch placement | Hold `Alt` | Enter/exit Branch Placement Mode | `src/supports/SupportTypes/Branch/useBranchPlacement.ts` + `src/supports/SupportTypes/Branch/BranchPlacementController.tsx` |
| Leaf placement | Hold `Ctrl+Alt` | Enter/exit Leaf Placement Mode | `src/supports/SupportTypes/Leaf/useLeafPlacement.ts` + `src/supports/SupportTypes/Leaf/LeafPlacementController.tsx` |
| Camera focus (pick) | Press `F` | Refocus camera at current hovered model point | `src/hotkeys/useCameraFocusHotkey.ts` (via `src/components/scene/camera/CameraFocusHotkeyController.tsx`) |

## Behavior notes (current implementation)

| Feature | What the user does | Result |
| --- | --- | --- |
| Branch placement | Hold `Alt`, click the model to set the “tip”, then either:
1) click a support shaft to snap the base, or
2) click the model again to create a mesh-to-mesh link | Produces a **Branch** when the second action is a shaft snap. Produces a **Twig** or **Stick** when the second action is model-to-model; Twig vs Stick is chosen by a distance cutoff (`settings.meshToMesh.stickVsTwigCutoffMm`). |
| Leaf placement | Hold `Ctrl+Alt`, click the model to set contact, then click a support shaft to snap/commit | Creates a Leaf with an integrated knot snapped to a shaft segment. |
| Brace placement | Hold `Alt` (shared), click a support shaft to set start, then click a second shaft to set end | Creates a brace between two valid shaft targets. |

## Remapping plan
- All hotkeys are intended to be user‑remappable in a future settings/preferences system.
- Documents reference the current defaults and link here for remapping details.

## Notes
- Where hotkeys overlap (e.g., `Ctrl+Alt` vs `Alt`), the more specific combo (`Ctrl+Alt`) takes precedence.
- `Escape` is intentionally hard-coded as a cancel key for placement flows (Branch/Leaf/Brace) and is not intended to be user-remappable.
- Brace placement currently shares the same configured key as Branch placement (`DEFAULT_KEYBINDINGS.SUPPORTS.BRANCH_PLACEMENT`). There is no separate brace binding in `hotkeyConfig.ts` yet.
- Some UI components also use keys locally (example: arrow keys inside the focused Layer Slider). These are not treated as global “hotkeys”.

# Hotkeys — Source of Truth

## Purpose
Centralize hotkey defaults in a compact, readable format and note that all hotkeys are remappable in a future settings system.

## Defaults (current state)

| Feature | Default Hotkey (hold) | Action / Mode | Flow (summary) | Doc |
| --- | --- | --- | --- | --- |
| Branch placement | Alt | Enter Branch mode | Click 1 (on model): set model tip → move: base snaps to support (Path) → Click 2: finalize if snapped | [[Branch]] |
| Brace placement | Alt | Enter Brace mode | Click 1 (on support shaft): set Knot A → move: brace previews toward pointer → Click 2 (on support shaft): set Knot B and commit | [[Brace]] |
| Twig/Stick placement | Ctrl+Alt | Enter unified model‑to‑model placement | Click 1 (on model): set Tip A → move: preview Tip B → Click 2 (on model): commit; auto‑select Twig (short) vs Stick (long) by distance | [[Twig]], [[Stick]] |
| Leaf placement | Ctrl+Alt | Enter Leaf mode | Click 1: set model contact → move: integrated Knot snaps to support (Path) → Click 2: finalize if snapped | [[Leaf]] |
| Joint creation | J | Enter Joint creation | Hover shaft: snap preview → Click: insert joint at snapped location | [[Joint]] |

## Remapping plan
- All hotkeys are intended to be user‑remappable in a future settings/preferences system.
- Documents reference the current defaults and link here for remapping details.

## Notes
- Where hotkeys overlap (e.g., Ctrl+Alt vs Alt), the more specific combo (Ctrl+Alt) takes precedence.
- Alt is context‑sensitive:
  - Alt on the model surface starts Branch placement.
  - Alt on a support shaft starts Brace placement.
- Ctrl+Alt is intentionally shared between Leaf and Twig/Stick; each follows its documented flow (Leaf: model → support; Twig/Stick: model → model with auto Twig vs Stick by distance).
- Each feature’s doc should link back to [[Hotkeys]].

# DEPRECATED: Hotkey Reference

> [!WARNING]
> This document is deprecated. Use centralized hotkey system.
> See new spec: [docs/hotkeys/README.md]
This page summarizes support-placement hotkey behavior.

## Precedence

When modifiers overlap, more specific combinations win:

1. `Ctrl+Alt` → Leaf family
2. `Alt` → Branch/Brace family
3. `Ctrl` → Kickstand family
4. No modifier → Default trunk placement

Key press order does not matter.

## Support placement rules

- `Alt` plus a model-first click enters the branch flow.
- `Alt` plus a support-first click enters the brace flow.
- `Ctrl` plus a support-first click enters kickstand placement.
- `Ctrl+Alt` always owns the interaction for leaf placement when the first valid click is on the model.

## Resolution matrix

### No modifier

- First click on model → default trunk/root placement.

### Alt held

- First click target decides the placement family:
  - **First click on model** → branch-family flow.
    - Second click on support shaft → **Branch**.
    - Second click on model → **Twig** or **Stick**.
  - **First click on support shaft** → brace-family flow.
    - Second support click → **Brace**.

### Ctrl held

- First click on support shaft → Kickstand.

### Ctrl+Alt held

- First click on model → Leaf flow.
  - Second click on support shaft → Leaf.

## Cancellation rules

- Releasing a required modifier key cancels the active placement family.
- Canceling clears preview/snap/hover transient state.
- Re-entering starts from a fresh state (no stale preview resurrection).

## Explicitly forbidden outcomes

- `Ctrl+Alt` should never fall through to kickstand or Alt-only branch behavior.
- Key order must not change the final result when the held modifiers are the same.
- Re-entering placement must not resurrect stale preview state.

## Quick cheat sheet

- `Alt` + model first → Branch/Twig/Stick
- `Alt` + support first → Brace
- `Ctrl` + support first → Kickstand
- `Ctrl+Alt` + model first → Leaf

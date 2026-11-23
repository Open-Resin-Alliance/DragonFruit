# Panel Docking

`FloatingPanelStack` places every tool panel in one of three places: the left
dock, the right dock, or a floating position. A panel's placement is keyed by
its React key, not by the tool that rendered it, so a panel keeps its dock,
order, and float position across tool switches and reloads.

## Public surface

- `src/components/layout/FloatingPanelStack.tsx` — `FloatingPanelStack` and
  `useFloatingPanelCollapse`.
- `src/components/layout/floatingLayoutPreferences.ts` — the storage key, the
  legacy key read once for migration, and the persistence toggle.
- Panel identity is the React `key` on the element passed as a child. Use a
  stable, tool-prefixed key (`prepare-transform-controls`, `support-settings`).
- A panel header marks itself with `data-panel-drag-handle="true"`. A control
  that must not start a panel drag sets `data-no-drag`.

## Model

Each panel has one placement:

```ts
type PanelPlacement = {
  dock: 'left' | 'right' | 'float';
  order: number;
  float?: { x: number; y: number };
};
```

- Defaults live in `DEFAULT_PANEL_DOCKS` in the stack. A panel not named there
  starts in the right dock, in the order the tool renders it.
- Dragging a header moves the panel. Releasing over a dock inserts it at the
  nearest order; releasing over the canvas floats it at the drop point.
- A dock is a flex column at a fixed width: the base width of the widest panel it
  holds plus padding, clamped to 200..520 px. Nothing resizes it.
- The model lists (`RESIZABLE_PANELS`) own their width instead. A hover-revealed
  handle on the panel's edge drags it in either state, and the width lives on the
  panel's placement — so a docked model list may grow past its dock, spilling
  over the canvas, and it keeps that width when it is undocked. It can only be
  widened: the base width every panel ships with is the floor. The dock drops
  its clipping only while a panel does this, so it otherwise still scrolls.
- `useFloatingPanelCollapse` owns a panel's expanded state. A dock that no
  longer fits collapses its lowest expanded panels before it scrolls.
- The layout is saved under `lumenslicer:floating-panel-layout:v6`. The v5 key
  is read once: a moved panel parked near an edge joins that dock, anything
  else keeps its floating position.
- Right-click a header for `Reset Window` (one panel) and `Reset Layout` (all).

## Adding a panel

```tsx
<TransformControls key="prepare-transform-controls" {...props} />
```

Use a stable key. A key that changes per render creates a new panel and loses
its placement. A new panel does not need to register anywhere else; it appears
in its default dock on first render and can be moved from there.

## Constraints

- The stack is the only owner of placement. Panels do not position themselves.
- The left dock starts at `leftInsetPx`, the tool rail's width, so a panel is
  never drawn under the rail.
- The model lists are locked while the rail is a column. Locked panels cannot be
  dragged.
- The cross-section strip (`CrossSliderPanel`) is a fixed 48 px sidebar
  rendered outside the stack. The right dock is inset by its width.
- The layout is client-side only. It is not part of the scene file and does not
  travel with a VOXL.
- `leftInsetPx` and `railIsColumn` are the only layout inputs from the shell.

## Related pages

- `dev/ui-atoms.md` — the `Card` shell every panel uses.
- `dev/state-and-stores.md` — the persistence conventions.
- `dev/config-schemas.md` — the remaining `src/config` files.

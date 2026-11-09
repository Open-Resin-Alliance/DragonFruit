# Context Menu

Every right-click menu and dropdown list in the app is one widget:
`ContextMenu`, in `src/components/ui/ContextMenu.tsx`. A caller supplies the
anchor, the rows and what each row id does. The widget owns everything else —
placement, grouping, submenu flyouts, dismissal, and the ARIA roles — so all of
them look and behave the same.

## When to reach for it

Any surface that offers a short list of commands anchored to a pointer or a
button. Do **not** hand-roll the shell: a menu written inline is how the app
ended up with five subtly different ones (different widths, padding, icon
treatments, stacking, and no ARIA roles at all in two cases).

Not every popover is a menu. A picker whose rows carry images, two lines of text
and per-row state — the topbar fleet quick switch, the slicing intent dropdown —
keeps its own markup; it is a list with a menu's anchor, not a command menu.

## Public surface

All of it is exported from `src/components/ui/ContextMenu.tsx`:

- `ContextMenu` — the component. Renders nothing while `position` is `null`, so
  callers can render it unconditionally and pass the open anchor.
- `ContextMenuEntry` — one row:
  - `id` (required) — stable key, and the value handed to `onSelect`. A row with
    children is a submenu and is never selected itself.
  - `label` (required) — any node, so each caller keeps its own i18n style
    (`<Trans>` in JSX, or `msg` descriptors resolved with `_`).
  - `icon` — a Lucide icon for the row's icon slot. `iconNode` replaces the slot
    with arbitrary content (a slot number badge, for example). `checked` puts a
    tick there instead — for toggles.
  - `disabled`, `danger` (destructive styling), `trailing` (right-aligned
    secondary text), `startsGroup` (a rule above the row; ignored on the first
    row), `children` (the flyout's rows, which are leaves).
- `ContextMenuProps` — `position`, `entries`, `onSelect`, `onClose`, plus
  `title` (heading row; omit for a headerless menu), `ariaLabel`,
  `dismissIgnoreRef`, `widthClassName`, `zIndexClassName`.

## Minimal usage

```tsx
const [menuPosition, setMenuPosition] = React.useState<{ x: number; y: number } | null>(null);

const entries: ContextMenuEntry[] = [
  { id: 'rename', label: <Trans>Rename</Trans>, icon: Pencil },
  { id: 'delete', label: <Trans>Delete</Trans>, icon: Trash2, danger: true, startsGroup: true },
];

<div onContextMenu={(event) => {
  event.preventDefault();
  setMenuPosition({ x: event.clientX, y: event.clientY });
}}>
  <ContextMenu
    position={menuPosition}
    entries={entries}
    onSelect={(id) => { if (id === 'rename') beginRename(); }}
    onClose={() => setMenuPosition(null)}
    title={<Trans>Presets</Trans>}
    ariaLabel={_(msg`Preset context menu`)}
  />
</div>
```

## Behaviour the widget owns

- **Placement.** The menu measures itself after mount and clamps into the
  viewport before the paint, so a menu that would run off the bottom edge moves
  up instead. Flyouts measure too: they flip up, and to the other side, from
  their real box rather than a row-height estimate — which is why the chevron of
  an open submenu points the way its flyout actually opened.
- **Dismissal.** Outside pointer down, `Escape` (through the shared dialog stack
  in `src/hotkeys/useEscapeToClose.ts`), window resize and scroll all close the
  menu. The root stops pointer down from bubbling, so a click on a row never
  reaches the dismiss listener. Callers must not add their own listeners.
- **Selection.** Choosing a row calls `onSelect(id)` and then `onClose()`. The
  caller does not close the menu itself.
- **Dropdowns.** A menu opened by a toggle button passes the button's ref as
  `dismissIgnoreRef`; a pointer down on the button then does not dismiss, so the
  button's own click can toggle the menu closed.

## Constraints

- **Labels are nodes, not descriptors.** Resolution stays with the caller, so a
  menu inside a component that uses `<Trans>` does not have to switch to `msg`.
- **One level of nesting.** A submenu's rows are leaves; a flyout inside a flyout
  is not supported.
- **Portalled.** The menu renders into `document.body`, so it is never clipped by
  a panel's overflow or trapped by an ancestor's stacking context.
- **Caller-owned state.** The widget holds no domain state: the anchor, the rows
  and the reactions to `onSelect` live with the caller
  (`src/components/controls/ModelManagerPanel.tsx`,
  `src/components/layout/TopBar.tsx`,
  `src/components/layout/FloatingPanelStack.tsx`,
  `src/supports/Settings/components/PresetSelector.tsx`,
  `src/supports/Settings/AnatomyPreview/SupportAnatomyPreviewSlot.tsx`).
- **The editor canvas has a thin adapter.** `EditorContextMenu`
  (`src/components/ui/EditorContextMenu.tsx`) is the shared widget over the
  editor's `EditorMenuAction` vocabulary plus its `disabledActions` list; the
  Organic Cut tool supplies its own one-row lists through it
  (`src/features/organicCut/OrganicCutMounts.tsx`). New menus should use
  `ContextMenu` directly.

## Related pages

- [Localization](localization.md) — why labels are nodes and where strings go.
- [Notifications and Toasts](notifications.md) — the other transient surface,
  and where its stacking sits relative to menus.
- [Hotkeys](hotkeys.md) — the `Escape` path the widget registers through.
- [State and Stores](state-and-stores.md) — where the open anchor usually lives.

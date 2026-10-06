# UI atoms

The shared UI vocabulary lives in `src/components/atoms` (basic controls and
chrome) and `src/components/ui` (stateful widgets: menus, dialogs, tooltips,
numeric fields). A control that already exists there is not written again inline:
before this set existed, the same dialog shell appeared 43 times, the same button
shape 353 times, and the same 20px icon slot 46 times, each with slightly
different padding, colour mix or z-index.

Reach for an atom first. If nothing fits, extend the atom rather than growing a
private copy at the call site.

## The set

### Actions

- `Button` — `variant`: `primary`, `secondary`, `accent`, `danger` (solid), or
  the tinted family `tinted-accent`, `tinted-danger`, `tinted-warning`,
  `tinted-success` for confirm rows whose fill is the tone mixed into the
  surface. `size`: `xs`, `sm`, `md` (the app default), `lg`. The tinted variants
  read `--button-tint` from `src/app/globals.css`, so a tinted destructive
  button matches the theme instead of a hardcoded red.
- `IconButton` — `variant`: `solid` (the `ui-button` tile), `surface` (the
  bordered tile a modal or panel header uses), `ghost` (bare hit target, surface
  on hover). `size`: `xs` to `lg`, `tone`, and `active` for a toggle that is on.
- `IconChip` — the bordered square an icon sits in: `xs` for a 16px badge, `sm`
  for the 20px slot of a menu or list row, `md` and `lg` for tiles. Pass `icon`
  (a Lucide icon) or `children` for a tick, a number or a glyph. `tone` picks the
  colour triple from `ICON_TONE_STYLES` (`src/components/atoms/iconTone.ts`), the
  one place the warning, danger, accent and neutral tones are defined.
- `PanelCollapseToggle` — the chevron that expands a panel card. It carries the
  accessible name and `aria-expanded`, which the hand-rolled copies did not.

### Layout and form

- `SettingRow` — label and description on the left, control on the right,
  optionally in the settings tabs' inset card (`bordered`). Use `as="label"` when
  the control inside is a native input.
- `Card` / `CardHeader` — the floating panel shell.
- `Toggle` — the pill switch, with `role="switch"` and `aria-checked`. Pass
  `label` when no visible text names it.
- `SegmentedControl` — a row of mutually exclusive pills: ON/OFF switches, tab
  strips, two to four way pickers. `tone="accent-secondary"` is what the sidebar
  strips use; `fullWidth` stretches the options.
- `Input`, `Select`, `ColorSwatchInput`, `NumberInput` — form controls. The
  numeric fields (`NumberInput`, `miniStepperField`, `compactNumberField`,
  `scrollableNumberField`) own stepping, wheel handling and clamping; a call site
  that re-clamps with `Math.min`/`Math.max` is doing the atom's job.

### Feedback

- `ProgressBar` — the accent bar for long operations. `value` in 0 to 100, `null`
  when the total is not known yet (it then announces nothing), or
  `indeterminate` for the sweeping loop.
- `Spinner` — the busy glyph, one size vocabulary.
- `BlockingOverlay` — the non-dismissible busy sheet (dim backdrop, one panel).
  It is a status surface, not a dialog: `role="status"` with `aria-busy`, no
  `aria-modal`, because the user cannot interact with it.
- `Toast` / `ToastViewport` — see [Notifications and Toasts](notifications.md).

### Stateful widgets

- `ContextMenu` — every right-click menu and dropdown; see
  [Context Menu](context-menu.md).
- `StructuredDialogModal` — every dismissible dialog: title, optional subtitle
  and icon (`iconTone` reads the shared tone table), close affordance, actions.
- `Tooltip` / `MouseTooltip` — hover hints. `Tooltip` is the anchored,
  clamped one; `MouseTooltip` follows the cursor.

## Helpers the atoms share

- `clampToViewport` (`src/utils/math.ts`) — place an anchored box inside the
  viewport. Every anchored surface used to inline this with its own margin.
- `useOutsideDismiss` (`src/hooks/useOutsideDismiss.ts`) — outside pointer down,
  `Escape` through the dialog stack, resize and scroll, in one hook. Use it for a
  surface that is not a `ContextMenu` (a popover, an anchored editor) instead of
  wiring the listeners again.
- `clamp` and `quantizeToScale` (`src/utils/math.ts`) — bounds and grid snapping.

## Constraints

- **Atoms take content, not translations.** A label, title or `aria-label` is the
  caller's, so each file keeps its own i18n style (`<Trans>` or `msg` with `_`).
- **A11y belongs to the atom.** `Toggle`, `PanelCollapseToggle` and
  `BlockingOverlay` set their own roles and states; a call site that adds
  `role="switch"` to a `Toggle` is double-declaring it.
- **Do not fork a variant.** If a page needs a slightly different fill, add the
  variant (and its token) to the atom, or the copies come back.
- **`ui-` classes are the token layer.** `.ui-button`, `.ui-segmented-option`,
  `.ui-range` and friends in `src/app/globals.css` carry the shared look; atoms
  compose them, call sites do not restate their colours.

## Related pages

- [Context Menu](context-menu.md) — the menu widget and its dismissal rules.
- [Notifications and Toasts](notifications.md) — the transient surfaces.
- [Localization](localization.md) — where the strings live.
- [State and Stores](state-and-stores.md) — where a widget's open state belongs.

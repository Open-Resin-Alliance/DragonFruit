# Notifications and Toasts

!!! warning "There is no notification system"
    This page documents what exists, not a design. There is no queue, no
    `pushToast()`, and no shared lifetime. A toast is a pair of `useState`
    values plus its own timers, and adding one means writing another. Read this
    before adding a toast so you at least copy the right pattern — and see the
    consolidation entry in the internal backlog before deciding it is fine.

## The three paths

**1. The editor shell** — `src/features/notifications/useEditorToasts.ts` (~300 lines), extracted verbatim from `page.tsx`. It owns six toasts through **twelve `useState` values and eleven timer/raf refs**:

| Toast | State |
| ----- | ----- |
| Undo/redo action | `historyActionToast` + `isHistoryActionToastVisible` |
| Scene import | `isSceneImportToastVisible` (content read from `sceneImportReport`) |
| Export success | `exportSuccessToast` + `isExportSuccessToastVisible` |
| Export error | `exportErrorToast` + `isExportErrorToastVisible` |
| Save / autosave | `isSaveToastVisible` + `isSaveToastAnimatedVisible` + `saveToastMode` |
| Printing monitor error | `printingMonitorErrorToast` + `isPrintingMonitorErrorToastVisible` |

The hook returns every setter under its original name; the things that *trigger* a toast — the export flow, undo/redo, autosave, the print monitor, scene import — still live in `page.tsx` and call those setters.

**2. Support mode** — `src/components/ui/SupportToasts.tsx`, eighteen lines. Error tone only, a CSS `fadeIn` animation, and **no timer at all**: the caller owns how long `message` stays non-null.

**3. Inline, per-component** — `AutoBracingSettingsCard.tsx` and `page.tsx` render their own `<ToastViewport><Toast>` directly.

### Keep rendered strings out of toast state

The save toast holds a **mode** (`'saving' | 'autosaving'`), not a label; `NotificationStack` picks the message at render time with `_(msg\`Saving…\`)`. It used to store the finished string. Storing rendered text in state puts it outside the catalog and freezes it in whatever locale was active when the toast fired — so a new toast carries the state it needs to *choose* its message, never the message.

All three bottom out in the same two primitives, `Toast` and `ToastViewport` (`src/components/atoms/Toast.tsx`), which is the one piece that *is* shared.

## The pattern the shell repeats

Every toast in `useEditorToasts` runs the same two-timer dance, with its own hardcoded numbers:

1. A **fade** timeout flips the `is…Visible` flag, so the CSS transition plays.
2. A **clear** timeout, a few hundred ms later, nulls the content so the node unmounts.
3. Both refs are cleared on re-trigger and on unmount.

The durations are per-toast literals rather than named constants — the printing-monitor error fades at 2200 ms and clears at 2600; export fades at 3800 and clears at 4500; scene import derives its fade as `duration - 400`.

## Stacking is hand-computed

`NotificationStack.tsx` renders each toast in its own `ToastViewport` with a literal z-index (125 or 126) and an offset chosen by a conditional:

```tsx
offset={(historyActionToast || sceneImportReport) ? '4.5rem' : '1.25rem'}
```

That is the whole collision-avoidance strategy: one hardcoded two-case rule for the one overlap anyone hit. Two toasts that can appear together and are not covered by that conditional will overlap.

## Adding a toast today

1. Add the content + visibility `useState` pair in `useEditorToasts.ts` — content being whatever the message is chosen *from*, not the message.
2. Add fade and clear timeout refs, and clear them on unmount.
3. Write the show/hide effect, copying an existing one and picking durations.
4. Return the setters, and call them from the trigger site (usually `page.tsx`).
5. Add a `ToastViewport` block in `NotificationStack.tsx`, pick a z-index, and extend the offset conditional if it can coexist with another toast.

Five steps, four files, and a judgement call about offsets — for one message. That cost is the argument for the consolidation, not a reason to route around this page.

## Related pages

- [State and Stores](state-and-stores.md) — the module-store pattern a real toast queue would use
- [Registration Seams](registration-seams.md) — the register-and-dispatch shape used elsewhere

# System Notifications

Top-right, frosted-glass **System Notifications** for cross-cutting, out-of-flow events that should not block the editor: update available, print done, long-running printer errors. They are the fourth notification path in the app — distinct from the three bottom-corner toast paths documented in [Notifications and Toasts](notifications.md).

Reach for System Notifications when the message is **system-level, not editor-state**: the user can be in any mode or tab and still needs to see it, and the action is to open a destination (Settings → Updates, printer monitor) rather than to undo an editor operation. For editor-state feedback (saving, undo/redo, import report, per-component validation) use the existing `useEditorToasts` / `SupportToasts` / inline `ToastViewport` paths instead.

## Public surface

All system notifications flow through a single store and a single stack. The stack is mounted once at the app root and renders every notification that is currently pushed.

| File | Role |
| ---- | ---- |
| `src/features/notifications/systemNotificationStore.ts` | Store and API. Holds the `SystemNotification[]` array, `expiryMs` timers, and `isAllowSameVersionEnabled` flag for the updater debug path. |
| `src/components/organisms/SystemNotificationStack.tsx` | Rendering. Fixed `bottom-6 right-6 z-[130] w-[22rem]` frosted glass (`backdrop-blur-2xl 32px saturate 1.5`) stack with `df-fly-in-right` / `df-fly-out-right` (0.2s in / 0.18s out) and `df-system-expiry` progress bar. |
| `src/features/updater/GlobalUpdateIndicator.tsx` | Updater integration. Silent background check via `fetchUpdateInfo(channel, allowSame)` and pushes `update-available` via the store. |
| `src/app/page.tsx` | Mount point. Renders `<SystemNotificationStack />` alongside `<NotificationStack />` so system notifications are visible in every mode. |

Types in `systemNotificationStore.ts`:

| Symbol | Purpose |
| ------ | ------- |
| `SystemNotificationTone` | `'info' \| 'success' \| 'warning' \| 'error' \| 'accent' \| 'accent-secondary'` — controls icon border/bg/color. |
| `SystemNotificationAction` | `{ label, icon?, variant?: 'secondary' \| 'accent' \| 'accent-secondary' \| 'danger', onClick, closeOnClick? }` — rendered as `ui-button` row below the body. |
| `SystemNotification` | `{ id, title, subtitle?, tone?, icon?, hideIcon?, expiryMs?, dismissible?, progressPct?, versionChip?, onClose?, actions? }` — `id` is the dedup key; `expiryMs` drives both the `df-system-expiry` `h-0.5` bar and the `setTimeout` that calls `onClose` and `dismissSystemNotification`. Set `hideIcon: true` or `icon: null` to hide the `h-8 w-8` icon (e.g. `Update Available!` has no icon). |
| `pushSystemNotification(notification)` | Upsert by `id`. If `expiryMs` is set, starts/clears a `window.setTimeout` that dismisses and calls `onClose`. |
| `dismissSystemNotification(id)` | Removes by `id` and clears its timer. |
| `subscribeSystemNotifications(listener)` / `getSystemNotificationsSnapshot()` | `useSyncExternalStore` contract for `SystemNotificationStack`. |
| `isAllowSameVersionEnabled()` / `enableAllowSameVersionForSession()` | Per-session `Ctrl+Shift+U` flag until reload that makes updater checks use `allow_same_version=true` so `0.1.15 → 0.1.15` returns real `body_len=5461` changelog. |

## Minimal usage

System notifications are **leaf-module safe**: the store imports nothing from `@/features/*` or `@/components/*`, so any feature can depend on it without cycles. Keep it that way — never import from `GlobalUpdateIndicator` or printer code into the store.

Update available (existing, now via store):

```ts
import { pushSystemNotification } from '@/features/notifications/systemNotificationStore';
import { openSettingsModal } from '@/components/settings/settingsModalEvents';

pushSystemNotification({
  id: 'update-available',
  title: 'Update Available!',
  subtitle: 'Release August 29, 2026',
  tone: 'accent-secondary',
  hideIcon: true,
  versionChip: `Version ${info.version}`,
  expiryMs: 30_000,
  onClose: handleClose,
  actions: [
    { label: 'Remind me later', variant: 'secondary', onClick: handleDismiss },
    { label: 'View in Settings', variant: 'accent-secondary', onClick: () => { openSettingsModal('updates'); handleClose(); } },
  ],
});
```

Print done (future, printer networking):

```ts
import { pushSystemNotification } from '@/features/notifications/systemNotificationStore';

pushSystemNotification({
  id: `print-done-${buildPlateId}`,
  title: 'Print is Done',
  subtitle: `${printerName} • ${durationLabel}`,
  tone: 'success',
  expiryMs: 15_000,
  actions: [
    { label: 'View', variant: 'accent', onClick: () => openPrinterMonitor(printerId) },
  ],
});
```

Downloading progress reuses the same `id` with `progressPct` and no `expiryMs`:

```ts
pushSystemNotification({
  id: 'update-available',
  title: 'Downloading update',
  subtitle: `${pct}%`,
  tone: 'accent',
  progressPct: pct,
  expiryMs: null,
  actions: [],
});
```

Suppression when already in `Settings → Updates` is done by the *caller* (`GlobalUpdateIndicator` checks `isSettingsOpen()` via `div.fixed.inset-0.z-[50] h2` before pushing) — the store does not know about UI state.

## Constraints

- **One stack, one expiry bar.** `SystemNotificationStack` renders a `h-0.5` `df-system-expiry` bar only when `expiryMs` is set. Downloading/error use `progressPct` instead and `expiryMs: null` so the bar and the `30s` timer do not compete. Do not set both at once.
- **Id is the contract.** `pushSystemNotification` upserts by `id`. Re-pushing `update-available` with a new `progressPct` updates the same card; a new `print-done` id creates a second card stacked below with `gap-3`. Use stable ids (`print-done-${plateId}`) so a second completion for the same plate replaces rather than duplicates.
- **Leaf store.** `systemNotificationStore.ts` must stay a leaf — no imports from `@/features/updater/*`, `@/features/printing/*`, or `@/components/*`. Features import from the store, not the other way around. This is what lets the updater, printer monitor, and any future system-level feature share the same stack without cycles.
- **Reload semantics.** `isAllowSameVersionEnabled` is in-memory until reload (not `localStorage`). `Ctrl+Shift+U` enables it for the session so `fetchUpdateInfo(channel, true)` via `src-tauri/src/updater_channel.rs` `version_comparator >=` returns `current → current` with real GitHub `body` (`body_len=5461` dev) and `Update & Restart` flushes `window.__df_flushAutosave` before `downloadAndInstall`. A reload clears the flag.
- **Boundaries.** Do not use System Notifications for editor toasts (saving, undo/redo, import report, `SupportToasts`). Those stay bottom-center with `Toast`/`ToastViewport` and `useEditorToasts` as documented in `notifications.md`. System Notifications are top-right, frosted, and for destinations.

## Related pages

- [Notifications and Toasts](notifications.md) — the three bottom-corner toast paths this system complements
- [Tauri IPC and Native Bridge](tauri-ipc-bridge.md) — `check_updates` / `perform_update` and `allow_same_version` plumbing
- [State and Stores](state-and-stores.md) — external-store pattern used by `SystemNotificationStack`
- [History and Undo/Redo](history-and-undo-redo.md) — why `pushSystemNotification` upserts by `id` instead of queuing

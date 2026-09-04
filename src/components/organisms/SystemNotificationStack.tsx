'use client';

import React, { useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, CloudDownload } from 'lucide-react';
import {
  getSystemNotificationsSnapshot,
  subscribeSystemNotifications,
  dismissSystemNotification,
  type SystemNotification,
  type SystemNotificationAction,
} from '@/features/notifications/systemNotificationStore';

function toneStyles(tone?: SystemNotification['tone']) {
  switch (tone) {
    case 'error':
      return {
        border: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
        bg: 'color-mix(in srgb, #ef4444, var(--surface-1) 85%)',
        color: '#ef4444',
        icon: <AlertTriangle className="h-4 w-4" />,
      };
    case 'warning':
      return {
        border: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 40%)',
        bg: 'color-mix(in srgb, #f59e0b, var(--surface-1) 85%)',
        color: '#f59e0b',
        icon: <AlertTriangle className="h-4 w-4" />,
      };
    case 'success':
      return {
        border: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 40%)',
        bg: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 85%)',
        color: 'var(--accent-secondary)',
        icon: <CheckCircle2 className="h-4 w-4" />,
      };
    case 'accent':
      return {
        border: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
        bg: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
        color: 'var(--accent)',
        icon: <CloudDownload className="h-4 w-4" />,
      };
    default:
      return {
        border: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 40%)',
        bg: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 85%)',
        color: 'var(--accent-secondary)',
        icon: <CloudDownload className="h-4 w-4" />,
      };
  }
}

function ActionButton({ action, onClose }: { action: SystemNotificationAction; onClose?: () => void }) {
  const handleClick = () => {
    action.onClick();
    if (action.closeOnClick !== false) onClose?.();
  };
  const variant = action.variant ?? 'secondary';
  if (variant === 'secondary') {
    return (
      <button
        type="button"
        onClick={handleClick}
        className="flex-1 ui-button ui-button-secondary !h-9 px-4 text-sm inline-flex items-center justify-center gap-1.5"
      >
        {action.icon}
        {action.label}
      </button>
    );
  }
  const styleMap: Record<string, React.CSSProperties> = {
    accent: {
      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
      background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
      color: 'var(--accent)',
    },
    'accent-secondary': {
      borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
      background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 86%)',
      color: 'var(--accent-secondary)',
    },
    danger: {
      borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
      background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
      color: 'var(--danger)',
    },
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex-1 ui-button !h-9 px-4 text-sm inline-flex items-center justify-center gap-1.5"
      style={styleMap[variant] ?? styleMap.accent}
    >
      {action.icon}
      {action.label}
    </button>
  );
}

const EXIT_MS = 200;

export function SystemNotificationStack() {
  const storeNotifications = useSyncExternalStore(
    subscribeSystemNotifications,
    getSystemNotificationsSnapshot,
    getSystemNotificationsSnapshot,
  );

  // Displayed list preserves exiting items for slide-out animation.
  const [displayed, setDisplayed] = React.useState<SystemNotification[]>(storeNotifications);
  const [exitingIds, setExitingIds] = React.useState<Set<string>>(() => new Set());
  const timersRef = React.useRef<Map<string, number>>(new Map());

  // Sync displayed with store: add newcomers, keep exiting
  React.useEffect(() => {
    setDisplayed((prev) => {
      const storeIds = new Set(storeNotifications.map((n) => n.id));
      const prevIds = new Set(prev.map((n) => n.id));
      const storeMap = new Map(storeNotifications.map((n) => [n.id, n] as const));

      // Keep exiting items that are still animating (removed from store but in exitingIds)
      const next: SystemNotification[] = [];
      for (const n of prev) {
        if (storeIds.has(n.id) || exitingIds.has(n.id)) {
          // Update with fresh store version if still present
          next.push(storeMap.get(n.id) ?? n);
        }
      }
      for (const n of storeNotifications) {
        if (!prevIds.has(n.id) && !exitingIds.has(n.id)) next.push(n);
      }
      // If store reordered (unlikely), respect store order for non-exiting
      // Keep exiting items at their previous indices; new items appended per above is fine.
      return next;
    });
  }, [storeNotifications, exitingIds]);

  // Handle external removals (expiry, GlobalUpdateIndicator) that bypass handleDismiss:
  // if store removed an id that is still in displayed but not already exiting, animate it.
  React.useEffect(() => {
    const storeIds = new Set(storeNotifications.map((n) => n.id));
    const toExit = displayed.filter((n) => !storeIds.has(n.id) && !exitingIds.has(n.id));
    if (toExit.length === 0) return;
    setExitingIds((prev) => {
      const next = new Set(prev);
      for (const n of toExit) {
        next.add(n.id);
        const t = window.setTimeout(() => {
          setDisplayed((d) => d.filter((x) => x.id !== n.id));
          setExitingIds((p) => {
            const np = new Set(p);
            np.delete(n.id);
            return np;
          });
          timersRef.current.delete(n.id);
        }, EXIT_MS);
        timersRef.current.set(n.id, t);
      }
      return next;
    });
  }, [displayed, storeNotifications, exitingIds]);

  React.useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) window.clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  const handleDismiss = React.useCallback((n: SystemNotification) => {
    if (exitingIds.has(n.id)) return;
    setExitingIds((prev) => {
      const next = new Set(prev);
      next.add(n.id);
      return next;
    });
    // Ensure displayed contains the item (it already does)
    const t = window.setTimeout(() => {
      dismissSystemNotification(n.id);
      n.onClose?.();
      // Remove from displayed/exiting after store update will also trigger,
      // but clean locally as well in case store already removed
      setDisplayed((d) => d.filter((x) => x.id !== n.id));
      setExitingIds((p) => {
        const np = new Set(p);
        np.delete(n.id);
        return np;
      });
      timersRef.current.delete(n.id);
    }, EXIT_MS);
    timersRef.current.set(n.id, t);
  }, [exitingIds]);

  if (displayed.length === 0) return null;

  return (
    <>
      <style>{`@keyframes df-system-expiry { from { transform: scaleX(1); } to { transform: scaleX(0); } } @keyframes df-fly-in-right { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } } @keyframes df-fly-out-right { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }`}</style>
      <div className="fixed bottom-6 right-6 z-[130] flex flex-col gap-3 pointer-events-none">
        {displayed.map((n) => {
          const tone = toneStyles(n.tone);
          const showExpiry = !!n.expiryMs && n.expiryMs > 0;
          const isExiting = exitingIds.has(n.id);
          return (
            <div
              key={n.id}
              className="pointer-events-auto w-[22rem]"
              style={{ animation: isExiting ? `df-fly-out-right ${EXIT_MS}ms ease-in forwards` : 'df-fly-in-right 0.2s ease-out forwards' } as React.CSSProperties}
            >
              <div
                className="relative overflow-hidden rounded-xl border shadow-2xl backdrop-blur-2xl"
                style={{
                  background: 'color-mix(in srgb, var(--surface-0), transparent 12%)',
                  borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 8%)',
                  boxShadow: '0 18px 48px rgba(0,0,0,0.42)',
                  backdropFilter: 'blur(32px) saturate(1.5)',
                  WebkitBackdropFilter: 'blur(32px) saturate(1.5)',
                } as React.CSSProperties}
                role="alert"
                aria-live="polite"
              >
                <div className="flex flex-col items-center gap-1.5 p-3.5 text-center">
                  {n.hideIcon || n.icon === null ? null : (
                    <span
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
                      style={{ borderColor: tone.border, background: tone.bg, color: tone.color }}
                    >
                      {n.icon ?? tone.icon}
                    </span>
                  )}
                  <div className="min-w-0">
                    <div className="text-base font-bold leading-tight" style={{ color: n.tone === 'accent-secondary' || n.tone === 'success' ? 'var(--accent-secondary)' : 'var(--text-strong)' }}>
                      {n.title}
                    </div>
                    {n.subtitle && (
                      <div className="mt-1 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                        {n.subtitle}
                      </div>
                    )}
                  </div>
                </div>
                {n.versionChip && (
                  <div className="px-3.5 pb-2 -mt-1 text-center">
                    <span
                      className="inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-[11px] font-semibold"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
                        color: 'var(--accent)',
                      }}
                    >
                      {n.versionChip}
                    </span>
                  </div>
                )}
                {n.progressPct != null && (
                  <div className="px-3.5 pb-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-1)' }}>
                      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${n.progressPct}%`, background: 'var(--accent)' }} />
                    </div>
                  </div>
                )}
                <div
                  className="relative flex items-center gap-3 border-t px-4 py-3 overflow-hidden"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                >
                  {showExpiry && (
                    <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden" style={{ background: 'transparent' }}>
                      <div
                        className="h-full w-full origin-left"
                        style={{ background: 'var(--accent)', animation: `df-system-expiry ${n.expiryMs}ms linear forwards` }}
                      />
                    </div>
                  )}
                  {n.actions?.map((a, idx) => (
                    <ActionButton key={idx} action={a} onClose={() => handleDismiss(n)} />
                  ))}
                  {(!n.actions || n.actions.length === 0) && n.dismissible !== false && (
                    <button
                      type="button"
                      onClick={() => handleDismiss(n)}
                      className="flex-1 ui-button ui-button-secondary !h-9 px-4 text-sm"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

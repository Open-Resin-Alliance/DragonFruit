import type React from 'react';

export type SystemNotificationTone = 'info' | 'success' | 'warning' | 'error' | 'accent' | 'accent-secondary';

export type SystemNotificationAction = {
  label: React.ReactNode;
  icon?: React.ReactNode;
  variant?: 'secondary' | 'accent' | 'accent-secondary' | 'danger';
  onClick: () => void;
  closeOnClick?: boolean;
};

export type SystemNotification = {
  id: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  tone?: SystemNotificationTone;
  icon?: React.ReactNode | null;
  hideIcon?: boolean;
  expiryMs?: number | null;
  dismissible?: boolean;
  progressPct?: number | null;
  versionChip?: string | null;
  onClose?: () => void;
  actions?: SystemNotificationAction[];
};

type Listener = () => void;
let notifications: SystemNotification[] = [];
const expiryTimers = new Map<string, number>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeSystemNotifications(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSystemNotificationsSnapshot(): SystemNotification[] {
  return notifications;
}

export function pushSystemNotification(notification: SystemNotification): void {
  const existingIdx = notifications.findIndex((n) => n.id === notification.id);
  if (existingIdx !== -1) {
    notifications = [...notifications.slice(0, existingIdx), notification, ...notifications.slice(existingIdx + 1)];
  } else {
    notifications = [...notifications, notification];
  }
  const id = notification.id;
  if (expiryTimers.has(id)) {
    window.clearTimeout(expiryTimers.get(id)!);
    expiryTimers.delete(id);
  }
  if (notification.expiryMs && notification.expiryMs > 0) {
    const t = window.setTimeout(() => {
      dismissSystemNotification(id);
      notification.onClose?.();
    }, notification.expiryMs);
    expiryTimers.set(id, t);
  }
  emit();
}

export function dismissSystemNotification(id: string): void {
  const next = notifications.filter((n) => n.id !== id);
  if (next.length === notifications.length) return;
  notifications = next;
  if (expiryTimers.has(id)) {
    window.clearTimeout(expiryTimers.get(id)!);
    expiryTimers.delete(id);
  }
  emit();
}

export function clearSystemNotifications(): void {
  for (const t of expiryTimers.values()) window.clearTimeout(t);
  expiryTimers.clear();
  notifications = [];
  emit();
}

// Example future use: printer networking "Print is Done"
// Call from printer monitor: pushSystemNotification({ id: 'print-done-42', title: 'Print is Done', subtitle: 'Build plate XYZ • 2h 13m', tone: 'success', expiryMs: 15_000, actions: [{ label: 'View', variant: 'accent', onClick: () => openSettingsModal('printing') }] })


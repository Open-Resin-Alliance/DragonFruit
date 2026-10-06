"use client";

import React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';

/**
 * One right-click / dropdown menu entry.
 *
 * `label` is a node rather than a message descriptor or a string so callers keep
 * their own i18n style (`<Trans>` in JSX, `msg` descriptors resolved with `_`,
 * or a formatted value).
 */
export type ContextMenuEntry = {
  /** Stable key, and the value `onSelect` receives. A submenu's id is never selected. */
  id: string;
  label: React.ReactNode;
  icon?: LucideIcon;
  /** Custom icon-slot content (e.g. a slot number badge). Wins over `icon`. */
  iconNode?: React.ReactNode;
  /** Right-aligned secondary text, e.g. a "occupied" marker. */
  trailing?: React.ReactNode;
  /** Renders a tick in the icon slot — for toggles. Wins over `icon`/`iconNode`. */
  checked?: boolean;
  disabled?: boolean;
  /** Destructive action: row text and its hover fill use the danger colour. */
  danger?: boolean;
  /** Rule above this entry, breaking the list into groups. Ignored on the first entry. */
  startsGroup?: boolean;
  /** Nested flyout. The entry runs no action itself; its children are leaf rows. */
  children?: ContextMenuEntry[];
};

export type ContextMenuProps = {
  /** Viewport coordinates of the gesture that opened the menu. `null` renders nothing. */
  position: { x: number; y: number } | null;
  entries: ContextMenuEntry[];
  /** Called with the selected leaf's id. The caller closes the menu (`onClose`) from here. */
  onSelect: (id: string) => void;
  /** Dismissal — outside click, Escape, resize, or a row being chosen. */
  onClose: () => void;
  /** Heading row, already localized. Omit for a headerless menu. */
  title?: React.ReactNode;
  /** Accessible name for the menu. */
  ariaLabel?: string;
  /**
   * Pointer down inside this element does not dismiss — set it to the toggle
   * button that owns a dropdown menu, so its click can close the menu itself.
   */
  dismissIgnoreRef?: React.RefObject<HTMLElement | null>;
  /** Width class used for the menu and its flyouts. */
  widthClassName?: string;
  /** Stacking class for the menu (flyouts sit one above it). */
  zIndexClassName?: string;
};

const EDGE_MARGIN_PX = 8;
const SUBMENU_CLOSE_DELAY_MS = 120;
const MENU_SURFACE = 'rounded-lg border p-1.5 shadow-xl backdrop-blur-sm';
const MENU_SURFACE_STYLE: React.CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
};

type MenuRowProps = {
  label: React.ReactNode;
  icon?: LucideIcon;
  iconNode?: React.ReactNode;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  trailing?: React.ReactNode;
  hasPopup?: boolean;
  expanded?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

function MenuRow({
  label,
  icon: Icon,
  iconNode,
  checked = false,
  disabled = false,
  danger = false,
  trailing,
  hasPopup,
  expanded,
  onClick,
  onMouseEnter,
}: MenuRowProps) {
  const tone = disabled ? 'var(--text-muted)' : danger ? 'var(--danger)' : 'var(--text-strong)';
  const hoverFill = danger
    ? 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)'
    : 'color-mix(in srgb, var(--accent), var(--surface-1) 82%)';

  return (
    <button
      type="button"
      onClick={(event) => {
        if (disabled) return;
        onClick?.(event);
      }}
      disabled={disabled}
      aria-haspopup={hasPopup ? 'menu' : undefined}
      aria-expanded={hasPopup ? expanded : undefined}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
      style={{
        color: tone,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (disabled) return;
        event.currentTarget.style.background = hoverFill;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
      role="menuitem"
    >
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded border"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--surface-1)',
          opacity: disabled ? 0.8 : 1,
          color: checked && !disabled ? 'var(--accent)' : undefined,
        }}
      >
        {checked ? <Check className="h-3.5 w-3.5" /> : iconNode ?? (Icon ? <Icon className="h-3.5 w-3.5" /> : null)}
      </span>
      <span className={trailing ? 'flex-1' : undefined}>{label}</span>
      {trailing}
    </button>
  );
}

type SubmenuFlyoutProps = {
  entries: ContextMenuEntry[];
  onSelect: (id: string) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Reports the measured placement so the parent row's chevron can follow it. */
  onPlaced: (placement: { up: boolean; left: boolean }) => void;
  widthClassName: string;
};

function SubmenuFlyout({ entries, onSelect, onMouseEnter, onMouseLeave, onPlaced, widthClassName }: SubmenuFlyoutProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = React.useState({ up: false, left: false });

  // Measure before paint: the flyout's size depends on its rows and the row it
  // hangs off, so both the vertical and horizontal flips are decided from the
  // real box rather than an estimate that drifts as rows are edited.
  React.useLayoutEffect(() => {
    const element = ref.current;
    const anchor = element?.parentElement;
    if (!element || !anchor) return;

    const flyout = element.getBoundingClientRect();
    const row = anchor.getBoundingClientRect();
    const up = flyout.bottom > window.innerHeight - EDGE_MARGIN_PX && row.top - flyout.height >= EDGE_MARGIN_PX;
    const left = flyout.right > window.innerWidth - EDGE_MARGIN_PX && row.left - flyout.width >= EDGE_MARGIN_PX;
    if (!up && !left) return;

    const next = { up, left };
    setPlacement((previous) => (previous.up === next.up && previous.left === next.left ? previous : next));
    onPlaced(next);
  }, [entries, onPlaced]);

  return (
    <div
      ref={ref}
      role="menu"
      className={`absolute ${placement.up ? 'bottom-0' : 'top-0'} ${placement.left ? 'right-full mr-1' : 'left-full ml-1'} z-[131] ${widthClassName} ${MENU_SURFACE}`}
      style={MENU_SURFACE_STYLE}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="space-y-0.5">
        {entries.map((entry) => (
          <MenuRow
            key={entry.id}
            label={entry.label}
            icon={entry.icon}
            iconNode={entry.iconNode}
            checked={entry.checked}
            disabled={entry.disabled}
            danger={entry.danger}
            trailing={entry.trailing}
            onClick={() => onSelect(entry.id)}
            onMouseEnter={onMouseEnter}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The app's one context-menu widget: a positioned list of entries with optional
 * heading, grouping rules, danger rows, ticks and nested flyouts.
 *
 * The widget owns placement and dismissal — callers only own the open flag (via
 * `position`), the entries, and what each id does. See `docs/dev/context-menu.md`.
 */
export function ContextMenu({
  position,
  entries,
  onSelect,
  onClose,
  title,
  ariaLabel,
  dismissIgnoreRef,
  widthClassName = 'w-48',
  zIndexClassName = 'z-[130]',
}: ContextMenuProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = React.useState<{ left: number; top: number } | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = React.useState<string | null>(null);
  const [submenuPlacement, setSubmenuPlacement] = React.useState({ up: false, left: false });
  const submenuCloseTimerRef = React.useRef<number | null>(null);

  const open = position !== null;

  // Escape is registered through the shared dialog stack, so a menu closes
  // before whatever is behind it acts on the same press.
  useEscapeToClose(open, onClose);

  // Outside pointer down and window resizes dismiss. The root stops pointerdown
  // from bubbling, so clicks inside the menu (and its flyouts) never reach here.
  React.useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node | null;
      if (target && dismissIgnoreRef?.current?.contains(target)) return;
      onClose();
    };
    const dismissOnResize = () => onClose();
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', dismissOnResize);
    window.addEventListener('scroll', dismissOnResize, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', dismissOnResize);
      window.removeEventListener('scroll', dismissOnResize, true);
    };
  }, [dismissIgnoreRef, open, onClose]);

  // A reopened menu keeps the component mounted: the previous flyout is stale by
  // then. The clamped placement is not cleared here — the measurement below runs
  // in the same commit and rewrites it before the paint.
  React.useEffect(() => {
    setOpenSubmenuId(null);
    setSubmenuPlacement({ up: false, left: false });
  }, [position]);

  React.useEffect(() => () => {
    if (submenuCloseTimerRef.current !== null) window.clearTimeout(submenuCloseTimerRef.current);
  }, []);

  // Measure, then clamp into the viewport. Row heights follow the labels, so
  // estimating them silently drifts as entries change.
  React.useLayoutEffect(() => {
    if (!position) return;
    const element = rootRef.current;
    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(EDGE_MARGIN_PX, Math.min(position.x, window.innerWidth - width - EDGE_MARGIN_PX));
    const top = Math.max(EDGE_MARGIN_PX, Math.min(position.y, window.innerHeight - height - EDGE_MARGIN_PX));
    setPlacement((previous) => (previous && previous.left === left && previous.top === top ? previous : { left, top }));
  }, [position, entries, title]);

  const cancelSubmenuClose = () => {
    if (submenuCloseTimerRef.current === null) return;
    window.clearTimeout(submenuCloseTimerRef.current);
    submenuCloseTimerRef.current = null;
  };

  const scheduleSubmenuClose = () => {
    cancelSubmenuClose();
    submenuCloseTimerRef.current = window.setTimeout(() => {
      submenuCloseTimerRef.current = null;
      setOpenSubmenuId(null);
    }, SUBMENU_CLOSE_DELAY_MS);
  };

  const openSubmenu = (id: string, disabled: boolean) => {
    if (disabled) return;
    cancelSubmenuClose();
    setSubmenuPlacement({ up: false, left: false });
    setOpenSubmenuId(id);
  };

  if (!position || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      aria-label={ariaLabel}
      className={`fixed ${zIndexClassName} ${widthClassName} ${MENU_SURFACE}`}
      style={{
        ...MENU_SURFACE_STYLE,
        left: placement?.left ?? position.x,
        top: placement?.top ?? position.y,
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {title ? (
        <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {title}
        </div>
      ) : null}
      <div className="space-y-0.5">
        {entries.map((entry, index) => {
          const children = entry.children;

          if (children && children.length > 0) {
            const disabled = children.every((child) => child.disabled);
            const expanded = openSubmenuId === entry.id;

            return (
              <React.Fragment key={entry.id}>
                {entry.startsGroup && index > 0 && (
                  <div role="separator" className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
                )}
                <div className="relative" onMouseLeave={scheduleSubmenuClose}>
                  <MenuRow
                    label={entry.label}
                    icon={entry.icon}
                    disabled={disabled}
                    hasPopup
                    expanded={expanded}
                    onMouseEnter={() => openSubmenu(entry.id, disabled)}
                    onClick={() => openSubmenu(entry.id, disabled)}
                    trailing={(
                      <ChevronRight
                        className={`h-4 w-4 shrink-0 opacity-60 transition-transform ${submenuPlacement.left && expanded ? 'rotate-180' : ''}`}
                      />
                    )}
                  />
                  {expanded && (
                    <SubmenuFlyout
                      entries={children}
                      onSelect={(id) => {
                        onSelect(id);
                        onClose();
                      }}
                      onMouseEnter={cancelSubmenuClose}
                      onMouseLeave={scheduleSubmenuClose}
                      onPlaced={setSubmenuPlacement}
                      widthClassName={widthClassName}
                    />
                  )}
                </div>
              </React.Fragment>
            );
          }

          return (
            <React.Fragment key={entry.id}>
              {entry.startsGroup && index > 0 && (
                <div role="separator" className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
              )}
              <MenuRow
                label={entry.label}
                icon={entry.icon}
                iconNode={entry.iconNode}
                checked={entry.checked}
                disabled={entry.disabled}
                danger={entry.danger}
                trailing={entry.trailing}
                onClick={() => {
                  onSelect(entry.id);
                  onClose();
                }}
              />
            </React.Fragment>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

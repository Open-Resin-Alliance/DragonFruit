"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampToViewport } from '@/utils/math';

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** Where an anchored box wants to sit, and where it goes when that side has no room. */
type BoxPlacement = { preferred: Point; flipped: Point };

/**
 * Placement for a `trigger`-anchored box: centred beside the trigger, or centred
 * under it, with the mirror position as the fallback.
 */
function triggerPlacement(trigger: DOMRect, size: Size, placement: 'below' | 'right', gap: number): BoxPlacement {
  if (placement === 'right') {
    const y = trigger.top + trigger.height / 2 - size.height / 2;
    return {
      preferred: { x: trigger.right + gap, y },
      flipped: { x: trigger.left - gap - size.width, y },
    };
  }
  const x = trigger.left + trigger.width / 2 - size.width / 2;
  return {
    preferred: { x, y: trigger.bottom + gap },
    flipped: { x, y: trigger.top - gap - size.height },
  };
}

/** Placement for a cursor-following box: centred under the pointer, above it if not. */
function cursorPlacement(cursor: Point | null, size: Size, gap: number): BoxPlacement | null {
  if (cursor === null) return null;
  const x = cursor.x - size.width / 2;
  return {
    preferred: { x, y: cursor.y + gap },
    flipped: { x, y: cursor.y - gap - size.height },
  };
}

interface TooltipProps {
  /** Content to show inside the tooltip popover. Falsy content skips the tooltip entirely (children render unwrapped). */
  content: React.ReactNode;
  /** Vertical offset from the cursor, or from the trigger's bottom edge, in pixels (default 28). */
  offsetY?: number;
  /** Max width of the tooltip box (default 260). */
  maxWidth?: number;
  /**
   * A fixed box width, in pixels. Omitted, the box is `max-content` — exactly as
   * wide as its longest line. Fixed keeps a row of tooltips identical when their
   * text lengths differ, at the cost of blank space around the short ones.
   */
  width?: number;
  /**
   * What the popover hangs off. `cursor` (the default) follows the pointer;
   * `trigger` stays put under the element it belongs to, centred on it, which is
   * what a row of square buttons wants — the box does not slide around inside the
   * tile the pointer is crossing, and it still shows when the tile is reached by
   * keyboard focus.
   */
  anchor?: 'cursor' | 'trigger';
  /**
   * Which side a `trigger`-anchored popover takes. `below` (the default) suits a row
   * of controls; `right` puts the box beside the trigger, centred on it, which is
   * what a column wants — a box below would sit on the controls underneath it. Both
   * flip to the opposite side when the box would otherwise run off the viewport.
   */
  placement?: 'below' | 'right';
  /**
   * How long the pointer has to rest before the tooltip appears, in milliseconds.
   * Default 0 — immediate, which is right for a control that explains itself in one
   * word. Reach for a delay where the tooltip covers the thing being looked at, so a
   * pointer merely crossing it does not throw a box over the view.
   */
  delayMs?: number;
  /** Extra classes for the wrapping span, e.g. to pass through flex sizing (flex-1, h-full) from the trigger. */
  wrapperClassName?: string;
  /**
   * Make the wrapping span a block-level, full-width flex container instead of the
   * default shrink-to-fit inline-flex. Needed when the trigger is a truncating text
   * row: an inline-flex wrapper sizes to the trigger's untruncated content width,
   * which defeats `truncate`. The trigger still needs its own `min-w-0` to shrink.
   */
  fullWidth?: boolean;
  /** Children must be a single React element (the trigger). */
  children: React.ReactElement;
}

/**
 * Dragonfruit-style tooltip popover.
 *
 * Wraps a single child element. On hover/focus the tooltip appears
 * below the cursor — or, with `anchor="trigger"`, pinned under the
 * element itself — clamped to the viewport edges so it never
 * overflows off-screen.
 *
 * Styling matches the project convention: dark background,
 * accent border, rounded, shadowed.
 *
 * Usage:
 *   <Tooltip content="Explains what this does">
 *     <button>Label</button>
 *   </Tooltip>
 */
export function Tooltip({ content, offsetY = 28, maxWidth = 260, width, wrapperClassName, fullWidth, delayMs = 0, anchor = 'cursor', placement = 'below', children }: TooltipProps) {
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const delayTimerRef = useRef<number | null>(null);

  const clearDelay = () => {
    if (delayTimerRef.current === null) return;
    window.clearTimeout(delayTimerRef.current);
    delayTimerRef.current = null;
  };
  // Cancel a pending reveal on unmount, or a delayed tooltip would set state on a
  // component that is gone.
  useEffect(() => clearDelay, []);

  const handleMouseEnter = (e: React.MouseEvent) => {
    clearDelay();
    if (delayMs <= 0) {
      setHovered(true);
      setPos({ x: e.clientX, y: e.clientY });
      return;
    }
    const { clientX, clientY } = e;
    delayTimerRef.current = window.setTimeout(() => {
      delayTimerRef.current = null;
      setHovered(true);
      setPos({ x: clientX, y: clientY });
    }, delayMs);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Following the pointer is the whole job in cursor mode; in trigger mode a move
    // inside the trigger must not re-place a popover that is anchored to it.
    if (anchor === 'trigger' || !hovered) return;
    setPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseLeave = () => {
    clearDelay();
    setHovered(false);
    setPos(null);
  };

  // Trigger mode needs no cursor position: keyboard focus has none, and that is one
  // of the reasons it exists.
  const show = hovered && (anchor === 'trigger' || pos !== null);

  // The popover is placed by writing onto it, not by holding its position in state:
  // measuring it and moving it is work on the DOM, and doing it here — before the
  // browser paints — keeps the box from ever showing at a guessed spot, without
  // spending a render on a position only the browser needs.
  useLayoutEffect(() => {
    if (!show) return;
    const el = popoverRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const size = { width: box.width, height: box.height };
    const triggerRect = anchor === 'trigger' ? triggerRef.current?.getBoundingClientRect() : undefined;
    const spot = triggerRect
      ? triggerPlacement(triggerRect, size, placement, offsetY)
      : cursorPlacement(pos, size, offsetY);
    if (spot === null) return;

    // Keep the box on-screen — the same edge clamp (4px) as ever — and take the
    // other side of the anchor when the preferred one has no room. `right` runs out
    // of room to the right, and everything else runs out at the bottom.
    const placed = clampToViewport(spot.preferred, size, { margin: 4 });
    const outOfRoom = triggerRect && placement === 'right' ? placed.overflowRight : placed.overflowBottom;
    const settled = outOfRoom ? clampToViewport(spot.flipped, size, { margin: 4 }) : placed;
    // If still off-screen top, clamp to 4px from top
    el.style.left = `${settled.left}px`;
    el.style.top = `${settled.top < 4 ? 4 : settled.top}px`;
    el.style.visibility = 'visible';
  }, [show, pos, offsetY, content, anchor, placement]);

  if (!content) return children;

  // Portalled to <body> rather than left where it sits in the tree. `position: fixed`
  // resolves against the nearest ancestor that carries a transform, filter or
  // backdrop-filter — and inside the settings modal that is the panel itself, which
  // also clips with overflow:hidden. Left in place the popover is positioned against
  // the panel and then clipped away: present in the DOM, reported visible, and
  // painted nowhere.
  const popover = show ? (
    <div
      ref={popoverRef}
      className="fixed pointer-events-none z-[9999] rounded px-2 py-1.5 text-[11px] leading-tight font-medium shadow-lg"
      style={{
        // Placed by the layout effect above, hidden until it has been.
        left: 0,
        top: 0,
        visibility: 'hidden',
        background: 'rgba(24, 24, 24, 0.98)',
        color: 'var(--text-strong, #e0e0e0)',
        border: '1px solid var(--accent, #baf72e)',
        width: width ?? 'max-content',
        maxWidth,
        whiteSpace: 'normal',
        textAlign: 'left',
        boxShadow: '0 6px 32px 0 rgba(0,0,0,0.44), 0 1.5px 8px 0 rgba(0,0,0,0.28)',
      }}
    >
      {content}
    </div>
  ) : null;

  return (
    <span
      ref={triggerRef}
      className={wrapperClassName ? `inline-flex ${wrapperClassName}` : 'inline-flex'}
      style={fullWidth ? { display: 'flex', width: '100%', minWidth: 0 } : undefined}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {children}

      {popover && typeof document !== 'undefined'
        ? createPortal(popover, document.body)
        : null}
    </span>
  );
}

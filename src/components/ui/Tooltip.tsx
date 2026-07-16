"use client";

import React, { useLayoutEffect, useRef, useState } from 'react';

interface TooltipProps {
  /** Content to show inside the tooltip popover. Falsy content skips the tooltip entirely (children render unwrapped). */
  content: React.ReactNode;
  /** Vertical offset from the cursor (default 28). */
  offsetY?: number;
  /** Max width of the tooltip box (default 260). */
  maxWidth?: number;
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
 * below the cursor, clamped to the viewport edges so it never
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
export function Tooltip({ content, offsetY = 28, maxWidth = 260, wrapperClassName, fullWidth, children }: TooltipProps) {
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Real position, filled in once the popover has been measured. Kept separate from
  // `pos` (raw cursor position) so the very first mount can stay hidden instead of
  // flashing at a guessed spot before snapping to its centered, clamped position.
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = (e: React.MouseEvent) => {
    setHovered(true);
    setPos({ x: e.clientX, y: e.clientY });
    setCoords(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!hovered) return;
    setPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseLeave = () => {
    setHovered(false);
    setPos(null);
    setCoords(null);
  };

  const show = hovered && pos;

  // Runs synchronously after DOM mutation but before the browser paints, so the
  // guessed-position frame below is never actually shown on screen.
  useLayoutEffect(() => {
    if (!show || !pos) return;
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const halfW = rect.width / 2;
    // Horizontal clamping: prefer centered under cursor, but keep on-screen
    const left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, pos.x - halfW));
    let top = pos.y + offsetY;
    // Vertical clamping: if below viewport, flip above cursor
    if (top + rect.height > window.innerHeight - 4) {
      top = pos.y - offsetY - rect.height;
    }
    // If still off-screen top, clamp to 4px from top
    if (top < 4) top = 4;
    setCoords({ left, top });
  }, [show, pos, offsetY, content]);

  if (!content) return children;

  // Before the first measurement, fall back to a raw guess; the popover stays
  // invisible until `coords` is set, so this guess is never actually painted.
  let left = 0;
  let top = 0;
  if (show) {
    left = coords ? coords.left : pos.x;
    top = coords ? coords.top : pos.y + offsetY;
  }

  return (
    <span
      className={wrapperClassName ? `inline-flex ${wrapperClassName}` : 'inline-flex'}
      style={fullWidth ? { display: 'flex', width: '100%', minWidth: 0 } : undefined}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {children}

      {show && (
        <div
          ref={popoverRef}
          className="fixed pointer-events-none z-50 rounded px-2 py-1.5 text-[11px] leading-tight font-medium shadow-lg"
          style={{
            left,
            top,
            visibility: coords ? 'visible' : 'hidden',
            background: 'rgba(24, 24, 24, 0.98)',
            color: 'var(--text-strong, #e0e0e0)',
            border: '1px solid var(--accent, #baf72e)',
            width: 'max-content',
            maxWidth,
            whiteSpace: 'normal',
            textAlign: 'left',
            boxShadow: '0 6px 32px 0 rgba(0,0,0,0.44), 0 1.5px 8px 0 rgba(0,0,0,0.28)',
          }}
        >
          {content}
        </div>
      )}
    </span>
  );
}

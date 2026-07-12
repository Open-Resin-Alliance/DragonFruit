"use client";

import React, { useRef, useState } from 'react';

interface TooltipProps {
  /** Content to show inside the tooltip popover. */
  content: React.ReactNode;
  /** Vertical offset from the cursor (default 28). */
  offsetY?: number;
  /** Max width of the tooltip box (default 260). */
  maxWidth?: number;
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
export function Tooltip({ content, offsetY = 28, maxWidth = 260, children }: TooltipProps) {
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = (e: React.MouseEvent) => {
    setHovered(true);
    setPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!hovered) return;
    setPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseLeave = () => {
    setHovered(false);
    setPos(null);
  };

  const show = hovered && pos;

  // Compute clamped position (only after ref is available)
  let left = 0;
  let top = 0;
  if (show) {
    left = pos.x;
    top = pos.y + offsetY;
    const el = popoverRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      // Horizontal clamping: prefer centered under cursor, but keep on-screen
      const halfW = rect.width / 2;
      left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, pos.x - halfW));
      // Vertical clamping: if below viewport, flip above cursor
      if (top + rect.height > window.innerHeight - 4) {
        top = pos.y - offsetY - rect.height;
      }
      // If still off-screen top, clamp to 4px from top
      if (top < 4) top = 4;
    }
  }

  return (
    <span
      className="inline-flex"
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
            background: 'rgba(24, 24, 24, 0.98)',
            color: 'var(--text-strong, #e0e0e0)',
            border: '1px solid var(--accent, #baf72e)',
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

"use client";

import React from 'react';
import { createPortal } from 'react-dom';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ToolLayout } from '@/components/layout/floatingLayoutPreferences';
import { ContextMenu, type ContextMenuEntry } from '@/components/ui/ContextMenu';
import { useOutsideDismiss } from '@/hooks/useOutsideDismiss';

/** The docked column's width, also used to inset the floating panel stack. */
export const TOOL_RAIL_WIDTH_PX = 74;

/**
 * One row of an entry's flyout. The labels stay descriptors so the rail keeps
 * the app's translation style, and `onSelect` stays with the caller that knows
 * what the option means.
 */
export type ToolRailMenuEntry = {
  id: string;
  label: MessageDescriptor;
  /** Any SVG component: the rail's own drawn icons are options here too. */
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  /** Lights the option's tile: for a list of mutually exclusive modes, the one in use. */
  checked?: boolean;
  onSelect: () => void;
};

export type ToolRailEntry = {
  id: string;
  label: MessageDescriptor;
  hint: MessageDescriptor;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  active: boolean;
  /**
   * Tool modes wear the primary hue, panels the secondary one — the same split
   * Prepare mode has between its eight tools and `Models`, and Support mode has
   * between its three panels.
   */
  tone: 'tool' | 'panel';
  /** What clicking the entry does. Absent when it only opens a `menu`. */
  onSelect?: () => void;
  /**
   * When present the entry opens this list instead of running `onSelect`, which
   * is how an entry offers several variants of one thing (the support view
   * modes) without spending a rail slot on each.
   */
  menu?: ToolRailMenuEntry[];
  /** Fired on hover, with `true` while the pointer is on the entry. */
  onHover?: (entering: boolean) => void;
  /** Which side of the entry takes an extra gap, separating groups in the rail. */
  separated?: 'above' | 'below';
};

interface ToolRailProps {
  entries: ToolRailEntry[];
  /** Column down the left edge, or bar centred under the app bar. */
  layout: ToolLayout;
  /** Fired when the layout is switched from the rail's own context menu. */
  onLayoutChange: (layout: ToolLayout) => void;
}

/**
 * The Hollow tool's icon. Lucide has no shape for "a wall with a cavity", and
 * the ones it does have (Droplets, and friends) say *liquid* rather than
 * *emptiness*, so this is drawn here: one path filled `evenodd`, which paints a
 * solid square and punches a smaller square out of it. The fill stops at the
 * inner square's edge, so the hole reads as an outlined square inside a filled
 * one without any second colour.
 */
export function HollowShellIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 2.5h14a2.5 2.5 0 0 1 2.5 2.5v14a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 19V5A2.5 2.5 0 0 1 5 2.5Zm2 3A1.5 1.5 0 0 0 5.5 7v10A1.5 1.5 0 0 0 7 18.5h10a1.5 1.5 0 0 0 1.5-1.5V7A1.5 1.5 0 0 0 17 5.5H7Z"
      />
    </svg>
  );
}

/**
 * The Full view mode's icon: a support as the scene renders it — the thin cone
 * that meets the model, its member inclined down to the joint, then straight to
 * the plate. No base plate is drawn, because the icon is about the member being
 * *solid*, and a plate under it would just be a second thing to read.
 */
export function SolidSupportIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* The contact cone: a point at the model, its base exactly the member's
          width so the two read as one tapered object rather than an arrowhead
          stuck on a stick. */}
      <path d="M2.4 2.4 8.6 5 6 8Z" fill="currentColor" stroke="none" />
      {/* The member. Butt ends, so the foot stops at the plate instead of ending
          in a blob; the join rounds the bend. */}
      <path d="M7.3 6.5 15.2 13.1V20.9" strokeWidth={4} />
    </svg>
  );
}

/**
 * The Lines view mode's icon: the same support traced as dashes, with no solid
 * contact at all. The dash nearest the model stands in for the cone and is cut
 * on the same axis, so the two icons are recognisably one shape — the solid one
 * filled, this one broken — instead of "a support" and "an arrow".
 */
export function LineSupportIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      aria-hidden="true"
      {...props}
    >
      {/* Butt caps on purpose: a round cap adds half the stroke width to each end
          of a dash, and at these lengths that closes the gap and the shaft reads
          as one solid line again. */}
      <path d="M3.7 3.6 5.4 5" />
      <path d="M7.2 6.5 8.8 7.9" />
      <path d="M10.6 9.3 12.3 10.7" />
      <path d="M14.1 12.2 15.1 13.1" />
      <path d="M15.2 13.1V15.3" />
      <path d="M15.2 17.2V19.4" />
    </svg>
  );
}

/**
 * The Smoothing tool's icon: a sphere with a gloss mark and a sparkle on it — a
 * surface that has been polished. Line-drawn like the Lucide icons it sits beside,
 * so it takes the entry's colour, with the highlight broken into strokes rather
 * than swept as one arc so it reads as shine at 24px instead of as a second outline.
 */
export function SmoothingSphereIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      {/* One highlight down the upper left, then a pair of gloss dots: a cross-shape
          sparkle turns into a blob at 24px, dots survive the scale. */}
      <path d="M6.2 14.1a6.4 6.4 0 0 1 4.1-8.2" strokeWidth={1.4} />
      <path d="M15 6.9h0.01" strokeWidth={2.6} />
      <path d="M17.5 9.5h0.01" strokeWidth={1.6} />
    </svg>
  );
}

/**
 * The Split tool's icon: a square whose outline is interrupted either side of a
 * single shallow sine through its middle. Lucide's `Scissors` says "cut something
 * apart", but this tool splits one model along a drawn line, so the icon shows the
 * line — and the gap the outline leaves around it, which is what makes it read as a
 * cut rather than a line drawn across a shape.
 */
export function CutSeamIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <defs>
        <mask id="cut-seam-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect x="0" y="0" width="24" height="24" fill="white" />
          {/* What the cut takes with it: a shallow band either side of the sine, so
              the outline stops shortly before the seam instead of touching it. */}
          <path
            d="M0 8.9c4.2-1.6 7.8-1.6 12 0s7.8 1.6 12 0L24 15.1c-4.2 1.6-7.8 1.6-12 0s-7.8-1.6-12 0Z"
            fill="black"
          />
        </mask>
      </defs>

      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" mask="url(#cut-seam-mask)" />

      {/* The seam itself: one long, very shallow sine, edge to edge. */}
      <path d="M0 12c4.2-1.6 7.8-1.6 12 0s7.8 1.6 12 0" />
    </svg>
  );
}
/**
 * The two states an entry can be in, for one hue. Both tones take this same
 * recipe, so the rail reads as one set of controls and a hue change can never
 * drift between them: while off the entry is a 10% tint over the surface with a
 * 12% border, which is faint enough to read as a borderless box, and while on it
 * is the hue over `--surface-0` with a lighter border and an inset ring.
 */

function railEntryStyles(hue: string): { off: React.CSSProperties; on: React.CSSProperties } {
  return {
    off: {
      background: `color-mix(in srgb, ${hue} 10%, var(--surface-1))`,
      borderColor: `color-mix(in srgb, ${hue} 12%, var(--border-subtle))`,
      color: 'var(--text-muted)',
    },
    on: {
      background: `color-mix(in srgb, ${hue}, var(--surface-0) 78%)`,
      borderColor: `color-mix(in srgb, ${hue}, white 14%)`,
      color: 'var(--text-strong)',
      boxShadow: `0 0 0 1px color-mix(in srgb, ${hue}, transparent 74%) inset`,
    },
  };
}

/** Tool modes select something, so they wear the primary hue. */
const TOOL_STYLES = railEntryStyles('var(--accent)');
/** Panel entries open or close a panel, so they wear the secondary hue. */
const PANEL_STYLES = railEntryStyles('var(--accent-secondary)');

/**
 * The tool rail: a list of entries, in two layouts chosen in Settings and driven
 * by `ToolLayout` — a column down the left edge, or a bar centred under the app
 * bar. The vertical form takes a column of the window, so the panel stack insets
 * by `TOOL_RAIL_WIDTH_PX` while it is in use; the bar takes none and the stack
 * goes back to the edge.
 *
 * The entries themselves come from the caller, because the two modes offer
 * different things: Prepare lists its eight model tools plus the model list,
 * Support lists its three panels. A tool entry *selects* a mode; a panel entry
 * toggles a panel that is always mounted, because the window layout resolves
 * against the set of mounted panels.
 */
export function ToolRail({ entries, layout, onLayoutChange }: ToolRailProps) {
  const { _ } = useLingui();
  const [menuPosition, setMenuPosition] = React.useState<{ x: number; y: number } | null>(null);
  const [entryMenu, setEntryMenu] = React.useState<{ entry: ToolRailEntry; position: { x: number; y: number } } | null>(null);
  const [isFolding, setIsFolding] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const entryMenuRef = React.useRef<HTMLDivElement | null>(null);
  const hoverCloseTimerRef = React.useRef<number | null>(null);
  // Outside pointer down, Escape, resize and scroll — the same lifecycle the
  // layout menu gets from `ContextMenu`. The flyout is its own ignore target, so
  // choosing an option is not a dismissal.
  useOutsideDismiss(entryMenu !== null, () => setEntryMenu(null), { ignoreRef: entryMenuRef });
  const entryRectsRef = React.useRef<Array<DOMRect>>([]);
  const previousLayoutRef = React.useRef(layout);

  // Fold the entries from where they were to where they now are: measure, invert,
  // animate — with a quarter turn so they tumble over the edge instead of
  // teleporting. Clockwise on the way down to the bar, anticlockwise on the way
  // back up to the column.
  //
  // The rail is a scroll container, so `isFolding` lifts the clip for the length
  // of the flight: a turned entry is wider than the 68px column and would
  // otherwise be cut off against its own box.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const railEntries = [...container.querySelectorAll<HTMLElement>('[data-rail-entry="true"]')];
    const previousRects = entryRectsRef.current;
    const layoutChanged = previousLayoutRef.current !== layout;
    previousLayoutRef.current = layout;

    if (layoutChanged) {
      setIsFolding(true);
    }

    const animations: Animation[] = [];

    // Clockwise on the way down to the bar, anticlockwise on the way back up.
    // A lean, not a quarter turn: a tile rotated 90° reads as a diamond with
    // sideways text. On the way down every entry sweeps the full width, so the
    // middle of the flight dips in opacity and the crossings blend instead of
    // piling up over the scene.
    const foldDegrees = layout === 'horizontal' ? 26 : -26;

    railEntries.forEach((entry, index) => {
      const nextRect = entry.getBoundingClientRect();
      const previousRect = previousRects[index];

      if (layoutChanged && previousRect) {
        const dx = previousRect.left - nextRect.left;
        const dy = previousRect.top - nextRect.top;
        // Upright at both ends, so an entry waiting out its stagger delay shows
        // the pose it is leaving; `fill: backwards` holds that first keyframe.
        animations.push(entry.animate(
          [
            { offset: 0, transform: `translate(${dx}px, ${dy}px) rotate(0deg)`, opacity: 0.85 },
            { offset: 0.5, transform: `translate(${dx * 0.35}px, ${dy * 0.35}px) rotate(${foldDegrees}deg)`, opacity: 0.4 },
            { offset: 1, transform: 'translate(0px, 0px) rotate(0deg)', opacity: 1 },
          ],
          {
            duration: 240,
            delay: index * 8,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            fill: 'backwards',
          },
        ));
      }

      previousRects[index] = nextRect;
    });

    if (animations.length > 0) {
      void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
        .then(() => setIsFolding(false));
    }
  }, [layout]);

  // Right-clicking any entry offers the layout, so the rail can be moved without
  // a trip to Settings.
  const openLayoutMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setEntryMenu(null);
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  // A left click on an entry that carries a menu opens it beside the entry —
  // right of the column, below the bar — the way the layout menu opens where the
  // pointer asked for it.
  const openEntryMenuFor = (entry: ToolRailEntry, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const count = entry.menu?.length ?? 1;
    // The tiles are 62px wide with a 6px gap, the same as the bar's own tiles.
    const rowWidth = count * 62 + (count - 1) * 6;
    setMenuPosition(null);
    setEntryMenu({
      entry,
      // Both layouts spread the list sideways: right of the tile in the column,
      // below and centred on it in the bar. Only where it starts changes.
      position: layout === 'vertical'
        ? { x: Math.min(rect.right + 6, window.innerWidth - rowWidth - 8), y: rect.top }
        : {
          x: Math.min(Math.max(8, rect.left + rect.width / 2 - rowWidth / 2), window.innerWidth - rowWidth - 8),
          y: rect.bottom + 6,
        },
    });
  };

  // Hovering is how the list is meant to be read, so entering the tile opens it
  // and a short grace period on leaving keeps it open while the pointer crosses
  // the gap into the flyout.
  const cancelHoverClose = () => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };
  const scheduleHoverClose = () => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => setEntryMenu(null), 220);
  };
  React.useEffect(() => cancelHoverClose, []);

  const layoutMenuEntries: ContextMenuEntry[] = [
    { id: 'vertical', label: _(msg`Vertical`), checked: layout === 'vertical' },
    { id: 'horizontal', label: _(msg`Horizontal`), checked: layout === 'horizontal' },
  ];

  // Only colours and the hover brightness are transitioned. `transition-all` also
  // watched width and transform, so the layout swap made the browser tween the
  // entry's own box (a column entry is a scrollbar narrower than `w-[68px]`, and
  // the scrollbar goes away in the bar) at the same time as the fold animation was
  // driving transform — two engines animating one property is the glitch.
  const entryClass = `flex h-[62px] flex-col items-center justify-center gap-1.5 rounded-sm border px-1 text-[11px] font-semibold leading-tight transition-[color,background-color,border-color,filter,box-shadow] duration-150 hover:brightness-110 ${layout === 'vertical' ? 'w-full' : 'w-[62px] shrink-0'}`;

  return (
    <div
      ref={containerRef}
      className={`${layout === 'vertical'
        ? 'fixed left-1.5 top-[var(--topbar-height)] bottom-0 z-40 flex w-[62px] flex-col items-stretch gap-1.5 overflow-y-auto py-1.5 custom-scrollbar pointer-events-auto'
        : 'fixed left-1/2 top-[calc(var(--topbar-height)+4px)] z-40 flex -translate-x-1/2 flex-row items-stretch gap-1.5 overflow-x-auto px-1.5 custom-scrollbar pointer-events-auto'}${isFolding ? ' !overflow-visible' : ''}`}
      data-no-drag="true"
      data-no-window-drag="true"
      role="toolbar"
      aria-orientation={layout === 'vertical' ? 'vertical' : 'horizontal'}
      aria-label={_(msg`Editor tools`)}
    >
      {entries.map((entry) => {
        const Icon = entry.icon;
        const styles = entry.tone === 'panel' ? PANEL_STYLES : TOOL_STYLES;
        const iconColor = entry.tone === 'panel'
          ? 'var(--accent-secondary)'
          : entry.active ? 'var(--accent)' : 'var(--text-muted)';
        const separation = entry.separated === 'below'
          ? (layout === 'vertical' ? ' mb-3' : ' mr-3')
          : entry.separated === 'above'
            ? (layout === 'vertical' ? ' mt-3' : ' ml-3')
            : '';
        const hasMenu = (entry.menu?.length ?? 0) > 0;
        const isMenuOpen = entryMenu?.entry.id === entry.id;

        return (
          <button
            key={entry.id}
            type="button"
            data-rail-entry="true"
            onClick={hasMenu
              ? (event) => {
                cancelHoverClose();
                if (entryMenu?.entry.id !== entry.id) openEntryMenuFor(entry, event.currentTarget);
              }
              : entry.onSelect}
            onMouseEnter={hasMenu
              ? (event) => {
                cancelHoverClose();
                openEntryMenuFor(entry, event.currentTarget);
              }
              : () => entry.onHover?.(true)}
            onMouseLeave={hasMenu ? scheduleHoverClose : () => entry.onHover?.(false)}
            onFocus={hasMenu
              ? (event) => {
                cancelHoverClose();
                openEntryMenuFor(entry, event.currentTarget);
              }
              : () => entry.onHover?.(true)}
            onBlur={() => entry.onHover?.(false)}
            onContextMenu={openLayoutMenu}
            className={`${entryClass}${separation}`}
            style={entry.active ? styles.on : styles.off}
            title={_(entry.hint)}
            aria-label={_(entry.hint)}
            {...(hasMenu
              ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': isMenuOpen }
              : { 'aria-pressed': entry.active })}
          >
            <Icon className="h-6 w-6" style={{ color: iconColor }} />
            <span>{_(entry.label)}</span>
          </button>
        );
      })}

      <ContextMenu
        position={menuPosition}
        entries={layoutMenuEntries}
        onSelect={(id) => onLayoutChange(id === 'horizontal' ? 'horizontal' : 'vertical')}
        onClose={() => setMenuPosition(null)}
        title={_(msg`Tool layout`)}
        ariaLabel={_(msg`Tool layout`)}
      />

      {/* An entry's own list, drawn as rail tiles rather than menu rows: the
          options are variants of the entry itself, so they read as the same
          control. It is portalled because the bar layout centres the rail with a
          transform, and `position: fixed` inside a transformed ancestor resolves
          against that ancestor rather than the viewport — the same reason
          `ContextMenu` portals. */}
      {entryMenu && createPortal(
        <div
          ref={entryMenuRef}
          role="menu"
          aria-label={_(entryMenu.entry.label)}
          className="fixed z-[121] flex flex-row gap-1.5"
          style={{ left: entryMenu.position.x, top: entryMenu.position.y }}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          {(entryMenu.entry.menu ?? []).map((option) => {
            const OptionIcon = option.icon;
            const optionIconColor = option.checked ? 'var(--accent-secondary)' : 'var(--text-muted)';

            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={option.checked === true}
                onClick={() => {
                  setEntryMenu(null);
                  option.onSelect();
                }}
                className={`${entryClass.replace('w-full', 'w-[62px]')} cursor-pointer`}
                style={option.checked ? PANEL_STYLES.on : PANEL_STYLES.off}
                title={_(option.label)}
              >
                {OptionIcon && <OptionIcon className="h-6 w-6" style={{ color: optionIconColor }} />}
                <span>{_(option.label)}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

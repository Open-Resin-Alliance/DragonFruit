"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ToolLayout } from '@/components/layout/floatingLayoutPreferences';
import { ContextMenu, type ContextMenuEntry } from '@/components/ui/ContextMenu';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The square tile's side, in pixels. The Tailwind classes that size the tiles have
 * to spell this number out — the scanner reads source text and does not evaluate
 * constants — so change the classes and this together.
 */
const TILE_SIZE_PX = 54;

/** The docked column's width — the tile plus its inset each side — also used to inset the floating panel stack. */
export const TOOL_RAIL_WIDTH_PX = TILE_SIZE_PX + 12;

/**
 * One entry of the rail: a tile, its tooltip, and what a click does.
 */
export type ToolRailEntry = {
  id: string;
  label: MessageDescriptor;
  hint: MessageDescriptor;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  active: boolean;
  /**
   * Wears the *other* recipe: the `off` one while `active`, the `on` one while not.
   * For the Models toggle, whose tile is the way to undo what `active` names — the
   * list is up, so the tile dims; the list is down, so it brightens and outlines.
   * `active` still means what it says in `aria-pressed`.
   */
  invertLit?: boolean;
  /**
   * Tool modes wear the primary hue, panels the secondary one — the same split
   * Prepare mode has between its eight tools and `Models`, and Support mode has
   * between its three panels.
   */
  tone: 'tool' | 'panel';
  /** What clicking the entry does. */
  onSelect?: () => void;
  /**
   * Renders the entry greyed and inert. For an entry whose feature depends on
   * something the scene may not have (interior view needs a hollowed model), so
   * the tile stays in place and explains itself instead of disappearing.
   */
  disabled?: boolean;
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
 * The Interior view's icon: the hollowing tool's two squares with the shell
 * broken into dots — the pattern is what the hollowing *removed*, so the outer
 * wall reads as taken away and the filled inner square as the cavity left to
 * look at. `HollowShellIcon` is the same idea from outside: one solid body with
 * the cavity punched out of it.
 *
 * Dots rather than dashes. A dash pattern has to be phased against the rounded
 * corners, and wherever a dash lands on one it bends through the arc, so the
 * sides come out uneven and the long dashes read as though they join back up at
 * icon size. A zero-length dash with a round cap is a dot: the same everywhere
 * and legible down to the 28px the rail draws. The gap divides the outline's
 * 71.7-unit perimeter into exactly 20, so the pattern closes with no seam where
 * the path starts.
 */
export function InteriorViewIcon(props: React.SVGProps<SVGSVGElement>) {
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
      <path
        d="M5 2.5h14a2.5 2.5 0 0 1 2.5 2.5v14a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 19V5A2.5 2.5 0 0 1 5 2.5Z"
        strokeDasharray="0.01 3.585"
      />
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.4" fill="currentColor" stroke="none" />
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
      {/* The drawing sits in the left half of the box, because the skeleton was
          traced against a plate line that is not drawn any more. The group
          recentres it and grows it a tenth — the same transform its dashed twin
          wears, so the pair stays one shape and the two tiles do not shift
          against each other as the mode changes. */}
      <g transform="translate(2.5 -1) scale(1.1)">
        {/* The contact cone: a point at the model, its base exactly the member's
            width so the two read as one tapered object rather than an arrowhead
            stuck on a stick. */}
        <path d="M2.4 2.4 8.6 5 6 8Z" fill="currentColor" stroke="none" />
        {/* The member: a shorter run on the incline, then a longer drop to the
            plate. Butt ends, so the foot stops at the plate instead of ending in a
            blob; the join rounds the bend. */}
        <path d="M7.3 6.5 11.6 10.1V21.2" strokeWidth={4} />
      </g>
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
      strokeWidth={1.9}
      aria-hidden="true"
      {...props}
    >
      {/* Same recentring and tenth-growth as `SolidSupportIcon`, so the two icons
          stay aligned to the pixel instead of sliding as the mode changes. */}
      <g transform="translate(2.5 -1) scale(1.1)">
        {/* Butt caps on purpose: a round cap adds half the stroke width to each end
            of a dash, and at these lengths that closes the gap and the shaft reads
            as one solid line again. */}
        <path d="M3.1 3 4.8 4.4" />
        <path d="M6.5 5.9 8.2 7.3" />
        <path d="M10 8.8 11.6 10.1" />
        <path d="M11.6 10.1V12.3" />
        <path d="M11.6 14.2V16.4" />
        <path d="M11.6 18.3V20.5" />
      </g>
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
 * The On-Face tool's icon: the model as a cube seen corner-on, up off the plate,
 * with an arrow settling it down onto the line. Lucide's `ArrowDownToLine` — the
 * icon this replaces — is a plain arrow onto a rule, which reads as "download" or
 * "drop to bottom" and says nothing about *which* face lands on the plate. Here
 * the body, the plate and the motion are one picture: the diamond is a solid on
 * its corner, the rule under it is the plate, and the arrow is the placement. The
 * arrow sits clear of the diamond's lower-left edge so the two never merge into a
 * blob at rail size.
 */
export function PlaceOnFaceIcon(props: React.SVGProps<SVGSVGElement>) {
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
      {/* The solid, corner-on: an equilateral diamond filling the upper right. */}
      <path d="M15.3 1.7 22.3 8.7 15.3 15.7 8.3 8.7Z" />
      {/* The plate: edge to edge, so the model reads as landing on a surface
          rather than resting on a tick mark. */}
      <path d="M1.9 21.8h20.2" />
      {/* The motion: a shaft down-left with an open head, held a clear step above
          the plate and clear of the diamond's lower-left edge. */}
      <path d="M8.3 12.6 3.2 17.7" />
      <path d="M3.2 13.4v4.3h4.3" />
    </svg>
  );
}

/**
 * The Islands tool's icon: a palm on its own island — the tool's picture of a
 * detached region, and the shape the tool used to borrow from Lucide's
 * `TreePalm` before it had to say *island* on its own.
 *
 * The palm is Lucide's `TreePalm` path data, scaled to 0.88 and dropped at
 * (1.44, -0.1) so the trunk's foot lands on the island's crest. The numbers are
 * baked in rather than left on a `<g transform>`: a transform would scale the
 * stroke with the geometry, so the group would have to set its own width to keep
 * the rail's 2, and a caller changing the width on the `<svg>` would then silently
 * miss it. Scaling the coordinates leaves one stroke width for the whole icon —
 * the same deal as every other icon in this file.
 */
export function IslandPalmIcon(props: React.SVGProps<SVGSVGElement>) {
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
      {/* The island: one flat, wide hump, so the sand either side of the trunk
          reads as land rather than as a stand the tree is planted on. */}
      <path d="M2.6 21.46c2.4-1.5 5.4-2.2 9.4-2.2s6.9.7 9.4 2.2" />
      {/* The palm, crown first: the two leaf fans, then the trunk down to the
          foot that lands on the island's crest. */}
      <path d="M12.88 6.94C12.88 4.511 10.715 2.54 8.04 2.54S3.2 4.511 3.2 6.94H4.96L5.84 6.06L6.72 6.94H10.24" />
      <path d="M12.88 6.183A5.122 5.122 0 0 1 15.96 5.18C18.635 5.18 20.8 7.151 20.8 9.58H18.16L17.28 8.7L16.4 9.58H13.76" />
      <path d="M6.623 8.445C4.731 10.337 4.599 13.258 6.315 14.983L10.046 11.243L10.662 10.627L11.287 10.002L13.153 8.137C11.437 6.412 8.515 6.553 6.623 8.445" />
      <path d="M11.12 13.54C11.56 15.74 10.97 17.5 10.24 19.26H13.76C15.52 14.42 13.32 8.7 12.88 6.94" />
    </svg>
  );
}

/**
 * The Automatic tool's icon: Lucide's `bot`, scaled up a touch.
 *
 * Lucide's glyphs sit in a 20-of-24-unit box so a wall of them reads evenly, but
 * next to this rail's drawn icons that padding just makes the robot look small.
 * The paths are Lucide's `bot` scaled 1.07 about the box centre, baked in — a
 * `<g transform>` takes the stroke width with the geometry, and this keeps the
 * rail's single 2-unit weight. The scale is bounded by the robot's ears, which
 * already reach x=2 and x=22: 1.07 leaves 0.3 units either side, and much more
 * clips them against the viewBox.
 */
export function AutoSupportIcon(props: React.SVGProps<SVGSVGElement>) {
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
      <path d="M12 7.72V3.44H7.72" />
      <rect width="17.12" height="12.84" x="3.44" y="7.72" rx="2.14" />
      <path d="M1.3 14.14h2.14" />
      <path d="M20.56 14.14h2.14" />
      <path d="M15.21 13.07v2.14" />
      <path d="M8.79 13.07v2.14" />
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
/** An entry with nothing to act on: neutral surface, muted, and dimmed on top. */
const DISABLED_STYLES: React.CSSProperties = {
  background: 'var(--surface-1)',
  borderColor: 'var(--border-subtle)',
  color: 'var(--text-muted)',
  // Dimmed here rather than with an `opacity-*` class: this Tailwind's scale has
  // no 45, so the class would be dropped and the tile would only look muted.
  opacity: 0.45,
};

// Only colours and the hover brightness are transitioned. `transition-all` also
// watched width and transform, so the layout swap made the browser tween the
// entry's own box (a column entry is a scrollbar narrower than `w-[54px]`, and
// the scrollbar goes away in the bar) at the same time as the fold animation was
// driving transform — two engines animating one property is the glitch.
const TILE_BASE = 'flex h-[54px] items-center justify-center rounded-[5.5px] border transition-[color,background-color,border-color,filter,box-shadow] duration-150 hover:brightness-110';

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
  const [isFolding, setIsFolding] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const entryRectsRef = React.useRef<Array<DOMRect>>([]);
  const previousLayoutRef = React.useRef(layout);

  // Fold the entries from where they were to where they now are: measure, invert,
  // animate — with a quarter turn so they tumble over the edge instead of
  // teleporting. Clockwise on the way down to the bar, anticlockwise on the way
  // back up to the column.
  //
  // The rail is a scroll container, so `isFolding` lifts the clip for the length
  // of the flight: a turned entry is wider than the 54px column and would
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
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const layoutMenuEntries: ContextMenuEntry[] = [
    { id: 'vertical', label: _(msg`Vertical`), checked: layout === 'vertical' },
    { id: 'horizontal', label: _(msg`Horizontal`), checked: layout === 'horizontal' },
  ];

  return (
    <div
      ref={containerRef}
      className={`${layout === 'vertical'
        ? 'fixed left-1.5 top-[var(--topbar-height)] bottom-0 z-40 flex w-[54px] flex-col items-stretch gap-1.5 overflow-y-auto py-1.5 custom-scrollbar pointer-events-auto'
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
        // Which recipe the tile wears. `invertLit` flips only this, never `active`.
        const lit = entry.invertLit === true ? !entry.active : entry.active;
        const iconColor = !lit
          ? 'var(--text-muted)'
          : entry.tone === 'panel' ? 'var(--accent-secondary)' : 'var(--accent)';
        const separation = entry.separated === 'below'
          ? (layout === 'vertical' ? ' mb-3' : ' mr-3')
          : entry.separated === 'above'
            ? (layout === 'vertical' ? ' mt-3' : ' ml-3')
            : '';
        const isDisabled = entry.disabled === true;
        // Where the tile sits in the rail and which side takes the group gap. The
        // tooltip's wrapper carries it, so the tile and its hint are one flex child.
        const geometry = `${layout === 'vertical' ? 'w-full' : 'w-[54px] shrink-0'}${separation}`;

        return (
          <Tooltip
            key={entry.id}
            content={(
              // The popover is a fixed width, so a centred short line over a longer
              // one reads as a caption for it rather than hanging left.
              <span className="block text-center">
                {_(entry.label)}
                <span className="block" style={{ color: 'var(--text-muted)' }}>{_(entry.hint)}</span>
              </span>
            )}
            // One box width for every tile rather than one sized per text, which is
            // what made the longest hint's box look nothing like its neighbours.
            // Narrow on purpose: the hint wraps instead of the box spreading.
            width={140}
            // Pinned under the tile rather than under the pointer: the box would
            // otherwise slide around inside the tile and sit differently on every
            // button. 8px clears the tile's own border. The column's tiles stack, so
            // there the box goes beside the tile instead of over its neighbours.
            anchor="trigger"
            placement={layout === 'vertical' ? 'right' : 'below'}
            offsetY={8}
            wrapperClassName={geometry}
          >
            <button
              type="button"
              data-rail-entry="true"
              disabled={isDisabled}
              onClick={entry.onSelect}
              onMouseEnter={isDisabled ? undefined : () => entry.onHover?.(true)}
              onMouseLeave={isDisabled ? undefined : () => entry.onHover?.(false)}
              onBlur={() => entry.onHover?.(false)}
              onContextMenu={openLayoutMenu}
              className={`${TILE_BASE} w-full${isDisabled ? ' cursor-not-allowed' : ''}`}
              style={isDisabled ? DISABLED_STYLES : lit ? styles.on : styles.off}
              aria-label={_(entry.label)}
              aria-pressed={entry.active}
            >
              <Icon className="h-7 w-7" style={{ color: isDisabled ? 'var(--text-muted)' : iconColor }} />
            </button>
          </Tooltip>
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
    </div>
  );
}

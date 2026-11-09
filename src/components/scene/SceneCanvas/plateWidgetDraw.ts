import * as React from 'react';
import type { IconNode } from 'lucide-react';

/**
 * The plate's name and the buttons beside it are drawn into canvas textures and
 * rendered as planes, instead of the drei `Html` they used to be.
 *
 * DOM always paints over the WebGL canvas, so a widget written in DOM drew on top
 * of the models that should hide it, however far behind it they stood. A plane is
 * in the depth buffer like the rest of the plate's decals, so a model in front of
 * a widget hides it.
 *
 * This is the half the two widgets share: the CSS-pixel-to-world conversion the old
 * `Html` implied, the theme colours the widgets wore as DOM, and the drawing
 * primitives — a rounded panel and a lucide icon — they are built from.
 */

/**
 * drei's `Html` sizes one CSS pixel of its content as 1/40 of a world unit at its
 * default `distanceFactor` of 10 — the same ratio it scales its occlusion mesh by —
 * multiplied by the element's own `scale`. A canvas plane for the same widget has to
 * keep that conversion, or the widget changes size on the plate.
 */
const CSS_PIXELS_PER_WORLD_UNIT = 40;

/**
 * World units one CSS pixel of a widget covers, for the `labelScale` the plate
 * hands its widgets.
 */
export function widgetWorldPerCssPixel(labelScale: number): number {
  return labelScale / CSS_PIXELS_PER_WORLD_UNIT;
}

/** The theme tokens the widgets paint with, as they were worn as DOM. */
export type PlateWidgetColors = {
  /** `--accent`: the plate's name, and the wash the locked button wears. */
  accent: string;
  /** `--text-strong`: the locked button's icon. */
  textStrong: string;
  /** `--text-muted`: quiet buttons and an unnamed plate. */
  textMuted: string;
  /** `--surface-0`: the quiet panel's translucent fill. */
  surface0: string;
  /** `--surface-1`: what the locked panel's accent wash sits on. */
  surface1: string;
};

/** The dark theme's values, for a document that is not there to read them from. */
const FALLBACK_COLORS: PlateWidgetColors = {
  accent: '#ec2a77',
  textStrong: '#f8f8fb',
  textMuted: '#c3c7cf',
  surface0: '#111216',
  surface1: '#1a1b21',
};

/** The widgets never appear in an exported thumbnail: as DOM they were not in the
 * WebGL frame a thumbnail is rendered from, and becoming meshes must not bake them
 * into it. */
export const PLATE_WIDGET_USER_DATA = {
  thumbnailCaptureExclude: true,
  thumbnailCaptureExcludeReason: 'plate-widget',
} as const;

export function readPlateWidgetColors(): PlateWidgetColors {
  if (typeof document === 'undefined') return FALLBACK_COLORS;
  const styles = getComputedStyle(document.documentElement);
  const token = (variable: string, fallback: string) => styles.getPropertyValue(variable).trim() || fallback;
  return {
    accent: token('--accent', FALLBACK_COLORS.accent),
    textStrong: token('--text-strong', FALLBACK_COLORS.textStrong),
    textMuted: token('--text-muted', FALLBACK_COLORS.textMuted),
    surface0: token('--surface-0', FALLBACK_COLORS.surface0),
    surface1: token('--surface-1', FALLBACK_COLORS.surface1),
  };
}

/**
 * The widgets' colours, re-read whenever the document's theme changes: they were
 * styled with `var(--accent)` and friends as DOM, so a theme switch has to reach
 * the textures as well — a light-theme scene must not keep painting the dark
 * theme's tokens into its plates.
 */
export function usePlateWidgetColors(): PlateWidgetColors {
  const [colors, setColors] = React.useState(readPlateWidgetColors);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setColors(readPlateWidgetColors()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}

/** A rounded rectangle at `radius` — the panel shape every widget button wears. */
export function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): Path2D {
  const r = Math.max(0, Math.min(radius, width * 0.5, height * 0.5));
  const right = x + width;
  const bottom = y + height;
  const path = new Path2D();
  path.moveTo(x + r, y);
  path.lineTo(right - r, y);
  path.arcTo(right, y, right, y + r, r);
  path.lineTo(right, bottom - r);
  path.arcTo(right, bottom, right - r, bottom, r);
  path.lineTo(x + r, bottom);
  path.arcTo(x, bottom, x, bottom - r, r);
  path.lineTo(x, y + r);
  path.arcTo(x, y, x + r, y, r);
  path.closePath();
  return path;
}

/** The box lucide draws its icons in; their stroke is 2 units of it. */
const ICON_VIEW_BOX = 24;

/**
 * Strokes a lucide icon into `ctx` from its node data — the same shapes the React
 * component renders, at the same weight: 2 units of stroke in a 24-unit box, with
 * round caps and joins. `x`/`y` are the icon box's top-left, `size` its side.
 */
export function drawPlateWidgetIcon(
  ctx: CanvasRenderingContext2D,
  icon: IconNode,
  { x, y, size }: { x: number; y: number; size: number },
  color: string,
): void {
  const scale = size / ICON_VIEW_BOX;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [tag, attrs] of icon) {
    const path = iconElementPath(tag, attrs);
    if (path) ctx.stroke(path);
  }
  ctx.restore();
}

/**
 * One element of a lucide node as a canvas path. `path` and `rect` are the two an
 * icon in these widgets uses; anything else lucide adds later draws nothing rather
 * than the wrong shape.
 */
function iconElementPath(tag: string, attrs: Record<string, string>): Path2D | null {
  if (tag === 'path') {
    const { d } = attrs;
    return d ? new Path2D(d) : null;
  }
  if (tag === 'rect') {
    return roundedRectPath(
      Number(attrs.x ?? 0),
      Number(attrs.y ?? 0),
      Number(attrs.width ?? 0),
      Number(attrs.height ?? 0),
      Number(attrs.rx ?? attrs.ry ?? 0),
    );
  }
  return null;
}

"use client";

import * as React from 'react';
import * as THREE from 'three';
import { useCursor } from '@react-three/drei';
import type { IconNode } from 'lucide-react';
import { __iconNode as layoutGridIcon } from 'lucide-react/dist/esm/icons/layout-grid.js';
import { __iconNode as lockIcon } from 'lucide-react/dist/esm/icons/lock.js';
import { __iconNode as lockOpenIcon } from 'lucide-react/dist/esm/icons/lock-open.js';
import { __iconNode as plusIcon } from 'lucide-react/dist/esm/icons/plus.js';
import { __iconNode as trash2Icon } from 'lucide-react/dist/esm/icons/trash-2.js';
import {
  PLATE_WIDGET_USER_DATA,
  drawPlateWidgetIcon,
  roundedRectPath,
  usePlateWidgetColors,
  widgetWorldPerCssPixel,
  type PlateWidgetColors,
} from './plateWidgetDraw';

type PlateWidgetAnchor = [number, number, number];

/** One button: `h-[104px] w-[104px]`, a `h-14 w-14` icon, `rounded-[5.5px]`, 1px border. */
const BUTTON_SIZE_CSS = 104;
const BUTTON_ICON_CSS = 56;
const BUTTON_RADIUS_CSS = 5.5;
const BUTTON_BORDER_CSS = 1;
/** The column's `gap-3`. */
const COLUMN_GAP_CSS = 12;
/** Canvas pixels per CSS pixel baked into a button's texture. */
const TEXTURE_SCALE = 4;
/** `.plate-trash-button`'s hover red, from globals.css. */
const DANGER_COLOR = '#ef4444';

/**
 * The buttons beside the build plate: add a plate and lock this one, hanging from the
 * plate's back edge; and the bin, standing on its front edge.
 *
 * Each button is its own plane in the plate's plane, placed in the CSS pixels the
 * widget was laid out in and scaled onto the plate by `labelScale`. That keeps the
 * column's spacing identical to the DOM's flex column — the drop between buttons is
 * computed in the plate's own plane now, so a plate viewed at an angle cannot shift
 * it, which is what an earlier attempt at separate HTML anchors got wrong.
 *
 * The panels and the lucide icons are painted into canvas textures rather than
 * written as DOM: DOM always paints over the canvas, so a model standing in front of
 * the buttons did not hide them. They are planes in the depth buffer now, hidden by
 * a model the way the plate itself is.
 *
 * The lock is deliberately *not* a document field: a lock is about the session you are
 * working in, not about the file, so it is not written to the scene and does not come
 * back with it.
 *
 * Runs inside the r3f reconciler, where the i18n provider is out of scope, so every
 * string arrives already translated — as the plate's name widget does. The wording
 * strings below (`addLabel` and the `*Title`s) were the DOM buttons' `aria-label`s and
 * tooltips. A mesh can carry neither, so they are no longer read; they stay in the
 * contract because `SceneEnvironment` builds its props from this type and the page
 * still translates and passes them.
 */
export function PlateSideButtons({
  onAdd,
  locked,
  onToggleLock,
  arrangeDisabled,
  onArrangePlate,
  clearDisabled,
  onClearPlate,
  columnAnchor,
  clearAnchor,
  facingRotation = 0,
  labelScale = 5,
}: {
  /** Accessible name of the add-plate button, already translated. */
  addLabel: string;
  /**
   * The add-plate button's hover wording, already translated. Only needed while the
   * button is inert: once there is somewhere to add a plate to (`onAdd`), it says what
   * it does like every other button here.
   */
  addComingSoonTitle?: string;
  /**
   * What adding a plate does. Absent while the app has nowhere to keep a second plate,
   * which is what leaves the button disabled and wearing the coming-soon wording.
   */
  onAdd?: () => void;
  locked: boolean;
  /** Wording shown while the plate is unlocked, i.e. what pressing the lock will do. */
  lockTitle: string;
  /** Wording shown while the plate is locked. */
  unlockTitle: string;
  onToggleLock: () => void;
  /** Arranging the plate: its wording, the wording while locked, and the action. */
  arrangeTitle: string;
  arrangeDisabledTitle: string;
  arrangeDisabled: boolean;
  onArrangePlate: () => void;
  /** Clearing the plate: the wording, the wording while the lock forbids it, and the action. */
  clearTitle: string;
  clearDisabledTitle: string;
  clearDisabled: boolean;
  onClearPlate: () => void;
  /** World position of the column's top-left corner. */
  columnAnchor: PlateWidgetAnchor;
  /** World position of the bin's bottom-left corner. */
  clearAnchor: PlateWidgetAnchor;
  /** In-plane rotation about Z; see the note in `PlateNameLabel`. */
  facingRotation?: number;
  /** World units per CSS pixel, scaled to the plate by the caller. */
  labelScale?: number;
}) {
  const colors = usePlateWidgetColors();
  const worldPerCssPixel = widgetWorldPerCssPixel(labelScale);
  const columnStepCss = BUTTON_SIZE_CSS + COLUMN_GAP_CSS;

  return (
    <>
      <group position={columnAnchor} rotation={[0, 0, facingRotation]}>
        <PlateWidgetButton
          icon={plusIcon}
          colors={colors}
          cssX={0}
          cssY={0}
          worldPerCssPixel={worldPerCssPixel}
          onClick={onAdd}
        />
        <PlateWidgetButton
          icon={locked ? lockIcon : lockOpenIcon}
          colors={colors}
          cssX={0}
          cssY={columnStepCss}
          worldPerCssPixel={worldPerCssPixel}
          onClick={onToggleLock}
          locked={locked}
        />
        <PlateWidgetButton
          icon={layoutGridIcon}
          colors={colors}
          cssX={0}
          cssY={columnStepCss * 2}
          worldPerCssPixel={worldPerCssPixel}
          onClick={arrangeDisabled ? undefined : onArrangePlate}
        />
      </group>

      {/* The bin's anchor is its bottom-left corner, so its top-left corner is one
          button's height *above* it in CSS pixels, i.e. forward along the plate. */}
      <group position={clearAnchor} rotation={[0, 0, facingRotation]}>
        <PlateWidgetButton
          icon={trash2Icon}
          colors={colors}
          cssX={0}
          cssY={-BUTTON_SIZE_CSS}
          worldPerCssPixel={worldPerCssPixel}
          onClick={clearDisabled ? undefined : onClearPlate}
          destructive
        />
      </group>
    </>
  );
}

/**
 * One square button of the plate's widget set: a rounded panel with a lucide icon,
 * painted into a canvas texture so it lives in the depth buffer, answering picks for
 * the action it stands for and brightening (or reddening) under the pointer the way
 * its CSS did.
 */
function PlateWidgetButton({
  icon,
  colors,
  cssX,
  cssY,
  worldPerCssPixel,
  onClick,
  locked = false,
  destructive = false,
}: {
  /** The button's lucide icon, as the node data the canvas strokes. */
  icon: IconNode;
  colors: PlateWidgetColors;
  /** Top-left corner of the button, in CSS pixels from the group's anchor. */
  cssX: number;
  cssY: number;
  worldPerCssPixel: number;
  /** What pressing it does; absent leaves the button greyed and inert. */
  onClick?: () => void;
  /** The accent panel the lock wears while the plate is locked. */
  locked?: boolean;
  /** Red under the pointer rather than brightened: the bin, which destroys work. */
  destructive?: boolean;
}) {
  const [hovered, setHovered] = React.useState(false);
  const disabled = !onClick;
  useCursor(hovered && !disabled);

  const texture = React.useMemo(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = BUTTON_SIZE_CSS * TEXTURE_SCALE;
    canvas.height = BUTTON_SIZE_CSS * TEXTURE_SCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);
    paintButtonPanel(ctx, { colors, icon, disabled, locked, hovered, destructive });
    const painted = new THREE.CanvasTexture(canvas);
    painted.colorSpace = THREE.SRGBColorSpace;
    return painted;
  }, [colors, disabled, destructive, hovered, icon, locked]);

  React.useEffect(() => () => texture?.dispose(), [texture]);

  const sizeWorld = BUTTON_SIZE_CSS * worldPerCssPixel;
  return (
    <mesh
      // CSS pixels run down the canvas, which the plate's plane runs backwards in:
      // the button's centre is half its size right of and below its top-left corner.
      position={[
        (cssX + BUTTON_SIZE_CSS / 2) * worldPerCssPixel,
        -(cssY + BUTTON_SIZE_CSS / 2) * worldPerCssPixel,
        0,
      ]}
      renderOrder={22}
      userData={PLATE_WIDGET_USER_DATA}
      onPointerOver={(event) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
      // The DOM buttons swallowed the pointer so the plate they hang beside never
      // saw the press; stopping it here keeps a pick on a button a pick on it alone.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
    >
      <planeGeometry args={[sizeWorld, sizeWorld]} />
      <meshBasicMaterial
        map={texture ?? undefined}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * Paints one button's panel: the inline styles it wore as DOM, and the pointer
 * feedback `.plate-trash-button` and `hover:brightness-110` used to give it, which a
 * canvas has to paint itself.
 */
function paintButtonPanel(
  ctx: CanvasRenderingContext2D,
  { colors, icon, disabled, locked, hovered, destructive }: {
    colors: PlateWidgetColors;
    icon: IconNode;
    disabled: boolean;
    locked: boolean;
    hovered: boolean;
    destructive: boolean;
  },
): void {
  // Stroked on its own centre, so the panel is inset by half a border to keep the
  // border inside the button, as a CSS border box does.
  const panel = roundedRectPath(
    BUTTON_BORDER_CSS / 2,
    BUTTON_BORDER_CSS / 2,
    BUTTON_SIZE_CSS - BUTTON_BORDER_CSS,
    BUTTON_SIZE_CSS - BUTTON_BORDER_CSS,
    BUTTON_RADIUS_CSS,
  );
  // `disabledButtonStyle` carries `opacity: 0.55`, which rides on every part of it.
  const opacity = disabled ? 0.55 : 1;
  // The bin only turns red while it can act; a locked plate's stays quiet and grey.
  const red = destructive && hovered && !disabled;

  // The panel: the quiet button is the plate showing through its own colour, the
  // locked and the red one the same colour washed over a solid panel.
  ctx.save();
  ctx.globalAlpha = opacity * (locked || red ? 1 : 0.45);
  ctx.fillStyle = locked ? colors.surface1 : colors.surface0;
  ctx.fill(panel);
  if (locked || red) {
    ctx.globalAlpha = opacity * (locked ? 0.15 : 0.12);
    ctx.fillStyle = locked ? colors.accent : DANGER_COLOR;
    ctx.fill(panel);
  }
  ctx.restore();

  // The border and the icon: grey while quiet, accent while locked, red on the bin
  // under the pointer.
  const tint = red ? DANGER_COLOR : locked ? colors.accent : colors.textMuted;
  ctx.save();
  ctx.globalAlpha = opacity * (disabled ? 0.4 : red ? 0.6 : locked ? 0.7 : 0.45);
  ctx.strokeStyle = tint;
  ctx.lineWidth = BUTTON_BORDER_CSS;
  ctx.stroke(panel);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = opacity;
  drawPlateWidgetIcon(
    ctx,
    icon,
    {
      x: (BUTTON_SIZE_CSS - BUTTON_ICON_CSS) / 2,
      y: (BUTTON_SIZE_CSS - BUTTON_ICON_CSS) / 2,
      size: BUTTON_ICON_CSS,
    },
    red ? DANGER_COLOR : locked ? colors.textStrong : colors.textMuted,
  );
  ctx.restore();

  // `hover:brightness-110`. The bin has its own red hover instead of a lift.
  if (hovered && !disabled && !red) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#ffffff';
    ctx.fill(panel);
    ctx.restore();
  }
}

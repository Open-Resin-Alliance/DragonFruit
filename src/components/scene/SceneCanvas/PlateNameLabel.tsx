"use client";

import * as React from 'react';
import * as THREE from 'three';
import { Html, useCursor } from '@react-three/drei';
import { __iconNode as pencilIcon } from 'lucide-react/dist/esm/icons/pencil.js';
import { fitFontToWidth } from '@/utils/canvasTextFit';
import {
  PLATE_WIDGET_USER_DATA,
  drawPlateWidgetIcon,
  roundedRectPath,
  usePlateWidgetColors,
  widgetWorldPerCssPixel,
  type PlateWidgetColors,
} from './plateWidgetDraw';

/** The label's `text-[36px] font-bold` in Arial, the font the scene's other canvas
 * text (the FRONT marker, the axis labels) is drawn in. */
const LABEL_FONT = '700 36px Arial';
/** `text-[36px] leading-tight`, in CSS pixels. */
const LABEL_LINE_HEIGHT_CSS = 45;
/** The name's `px-1` on either side. */
const LABEL_PADDING_CSS = 4;
/** `gap-2` between the name and the pencil. */
const LABEL_GAP_CSS = 8;
/** The pencil: `h-9 w-9` with an `h-5 w-5` icon, `rounded-[5.5px]` and a 1px border. */
const PENCIL_BUTTON_CSS = 36;
const PENCIL_ICON_CSS = 20;
const PENCIL_RADIUS_CSS = 5.5;
/** Widest the name may get before its font is shrunk to fit the texture. */
const LABEL_MAX_TEXT_CSS = 512;
/** Canvas pixels per CSS pixel baked into the label's texture. */
const TEXTURE_SCALE = 4;

/** The editor's box: `rounded-[5.5px] border px-2 py-1`, the field the name is typed
 * into, in CSS pixels. */
const EDITOR_PADDING_X_CSS = 8;
const EDITOR_PADDING_Y_CSS = 4;
const EDITOR_BORDER_CSS = 1;
const EDITOR_RADIUS_CSS = 5.5;
/** The narrowest the field gets, in characters: the `min-w` the CSS input had. */
const EDITOR_MIN_CHARS = 6;
/** The caret's width in CSS pixels, and how long each of its blinks lasts — the
 * browser's own caret period, which a painted one has to keep up with itself. */
const EDITOR_CARET_CSS = 2;
const CARET_BLINK_MS = 530;

/**
 * The build plate's name, written on the plate itself and clicked to change it.
 *
 * It is laid flat in world space rather than billboarded at the camera: the name
 * belongs to the plate, so it should slide and turn with it the way the grid
 * does, and only be readable from above — the view the plate is worked from.
 *
 * It is a plane in the depth buffer, not the DOM it used to be: DOM always paints
 * over the canvas, so the name drew on top of the models that should hide it. The
 * name and the pencil are painted into a canvas texture the same way the plate's
 * FRONT marker is.
 *
 * The editor is painted into that same texture too — the field is the name's own
 * plane while a name is being typed. A DOM editor cannot be: `Html` places it
 * through a second, CSS-3D projection of the scene, which agrees with the
 * renderer only near the anchor and drifts from it as the camera moves (most of
 * all under a perspective projection), so the field wandered off a plate whose
 * every other widget — all of them planes now — stayed put. A real `<input>` is
 * still the thing the keyboard talks to; it is simply kept out of sight, and the
 * plane draws what it holds.
 *
 * This runs inside the r3f reconciler, where the i18n provider is out of scope,
 * so every string arrives already translated, exactly as the plate's front-edge
 * label does.
 */
export function PlateNameLabel({
  name,
  placeholder,
  editTitle,
  emptyTitle,
  position,
  /**
   * In-plane rotation about Z. Left at 0 by default because the scene is Z-up:
   * the plate lies in XY, which is the plane the label's texture is drawn across,
   * with the text's up along +Y — the direction that reads correctly from the
   * front.
   */
  facingRotation = 0,
  /** World units per CSS pixel of the label, i.e. how large it sits on the plate. */
  labelScale = 5,
  onCommit,
}: {
  name: string;
  placeholder: string;
  /** Accessible name of the editor: the wording the edit affordance carried. */
  editTitle: string;
  /** The same, while the plate has no name yet. */
  emptyTitle: string;
  /** World position of the label's anchor point. */
  position: [number, number, number];
  facingRotation?: number;
  /** World units per CSS pixel of the label, i.e. how large it sits on the plate. */
  labelScale?: number;
  onCommit: (next: string) => void;
}) {
  // `null` means "not editing"; the draft is only meaningful while editing, so
  // the name shown otherwise is always the plate's own.
  const [draft, setDraft] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState(false);
  /** Which part of the draft the keyboard has, so the painted caret can follow it. */
  const [selection, setSelection] = React.useState({ start: 0, end: 0 });
  const [caretOn, setCaretOn] = React.useState(true);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  /** Set between a press on the field and the blur that press causes, so the
   * editor's own field does not close the editor (see the plane's `onPointerDown`). */
  const keepEditingRef = React.useRef(false);
  /** Set once the editor is being taken down. Unmounting the focused input raises a
   * blur of its own, and that blur must not commit a draft Escape just threw away. */
  const tearingDownRef = React.useRef(false);
  const isEditing = draft !== null;
  const colors = usePlateWidgetColors();
  const worldPerCssPixel = widgetWorldPerCssPixel(labelScale);

  const label = React.useMemo(
    () => buildLabelTexture({
      name,
      placeholder,
      colors,
      hovered,
      editing: isEditing,
      draft: draft ?? '',
      selection,
      caretOn,
    }),
    [caretOn, colors, draft, hovered, isEditing, name, placeholder, selection],
  );

  React.useEffect(() => () => label.texture?.dispose(), [label.texture]);

  React.useEffect(() => {
    if (!isEditing) return;
    setCaretOn(true);
    const id = window.setInterval(() => setCaretOn((on) => !on), CARET_BLINK_MS);
    return () => window.clearInterval(id);
  }, [isEditing]);

  useCursor(hovered);

  /** The input is the only thing that knows where the caret is: read it back for
   * the texture. A fresh keystroke shows the caret again, blink or not. */
  const readSelection = React.useCallback(() => {
    const element = inputRef.current;
    if (!element) return;
    setSelection({ start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 });
  }, []);

  const commitDraft = () => {
    if (draft === null) return;
    const next = draft.trim();
    // The editor is coming down here, so the blur that follows is this, not a
    // second commit of the same draft.
    tearingDownRef.current = true;
    setDraft(null);
    if (next !== name) onCommit(next);
  };

  const openEditor = () => {
    tearingDownRef.current = false;
    setDraft(name);
  };

  return (
    <>
      <group position={position} rotation={[0, 0, facingRotation]}>
        <mesh
          // The anchor is the label's bottom-left corner, so the plane's centre is
          // half its own size to the right of it and half a size further back.
          position={[
            (label.widthCss / 2) * worldPerCssPixel,
            (label.heightCss / 2) * worldPerCssPixel,
            0,
          ]}
          // The label has to answer picks or nothing opens the editor — and while
          // the editor is up this plane *is* the field, so it keeps answering them.
          renderOrder={22}
          userData={PLATE_WIDGET_USER_DATA}
          onPointerOver={(event) => {
            event.stopPropagation();
            setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
          onPointerDown={(event) => {
            event.stopPropagation();
            // The press goes to the canvas, which takes the focus the editor's input
            // needs. Hand it back once the browser has finished moving it — the blur
            // in between is this press, not the field being left, so it commits nothing.
            if (!isEditing) return;
            keepEditingRef.current = true;
            window.setTimeout(() => {
              keepEditingRef.current = false;
              inputRef.current?.focus();
            }, 0);
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (isEditing) return;
            openEditor();
          }}
        >
          <planeGeometry args={[label.widthCss * worldPerCssPixel, label.heightCss * worldPerCssPixel]} />
          <meshBasicMaterial
            map={label.texture ?? undefined}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      </group>

      {isEditing && (
        <Html
          position={position}
          transform
          rotation={[0, 0, facingRotation]}
          scale={labelScale}
          pointerEvents="none"
          style={{ opacity: 0 }}
        >
          {/* The input is what the keyboard types into, and the only DOM this widget
              has left. It is not drawn — the plane carries the field — and it does not
              answer the pointer, so it is the plane that decides what a press means. */}
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              readSelection();
              setCaretOn(true);
            }}
            onSelect={readSelection}
            onKeyUp={readSelection}
            onFocus={readSelection}
            onBlur={() => {
              if (keepEditingRef.current || tearingDownRef.current) return;
              commitDraft();
            }}
            onKeyDown={(event) => {
              // The editor is a real text field: the app's single-letter hotkeys
              // must not fire while a name is being typed.
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                tearingDownRef.current = true;
                setDraft(null);
              }
            }}
            placeholder={placeholder}
            aria-label={name ? editTitle : emptyTitle}
          />
        </Html>
      )}
    </>
  );
}

/**
 * Bakes the label into a canvas texture: either the name in the accent colour
 * (muted while the plate is unnamed) with the pencil beside it, or — while a name is
 * being typed — the field's box, with the draft and the caret in it. The texture's
 * CSS size comes back with it, because the plane it is drawn on is that size at
 * `labelScale`.
 */
function buildLabelTexture({ name, placeholder, colors, hovered, editing, draft, selection, caretOn }: {
  name: string;
  placeholder: string;
  colors: PlateWidgetColors;
  hovered: boolean;
  editing: boolean;
  draft: string;
  selection: { start: number; end: number };
  caretOn: boolean;
}): { texture: THREE.Texture | null; widthCss: number; heightCss: number } {
  const fallbackWidth = LABEL_PADDING_CSS * 2 + LABEL_GAP_CSS + PENCIL_BUTTON_CSS;
  const fallback = { texture: null, widthCss: fallbackWidth, heightCss: LABEL_LINE_HEIGHT_CSS };
  if (typeof document === 'undefined') return fallback;

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return fallback;
  if (editing) return buildEditorTexture(measure, { draft, placeholder, colors, selection, caretOn });

  const text = name || placeholder;
  // The plane is locked to the texture's aspect, so a long name has to shrink into
  // the same texture instead of running off the plate.
  const font = fitFontToWidth(measure, LABEL_FONT, text, LABEL_MAX_TEXT_CSS);
  measure.font = font;
  const textWidthCss = measure.measureText(text).width;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((LABEL_PADDING_CSS + textWidthCss + LABEL_GAP_CSS + PENCIL_BUTTON_CSS + LABEL_PADDING_CSS) * TEXTURE_SCALE);
  canvas.height = Math.ceil(LABEL_LINE_HEIGHT_CSS * TEXTURE_SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) return fallback;
  ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);

  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = name ? colors.accent : colors.textMuted;
  // Nudged below the vertical centre: `middle` centres the em box, and capitals sit
  // above its middle, so dead-centre reads high — the same nudge, scaled to this
  // font, that the plate's FRONT marker uses.
  ctx.fillText(text, LABEL_PADDING_CSS, LABEL_LINE_HEIGHT_CSS / 2 + 2);

  const pencilX = LABEL_PADDING_CSS + textWidthCss + LABEL_GAP_CSS;
  const pencilY = (LABEL_LINE_HEIGHT_CSS - PENCIL_BUTTON_CSS) / 2;
  const border = 1;
  const pencil = roundedRectPath(
    pencilX + border / 2,
    pencilY + border / 2,
    PENCIL_BUTTON_CSS - border,
    PENCIL_BUTTON_CSS - border,
    PENCIL_RADIUS_CSS,
  );
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = colors.surface0;
  ctx.fill(pencil);
  ctx.strokeStyle = colors.textMuted;
  ctx.lineWidth = border;
  ctx.stroke(pencil);
  ctx.restore();
  drawPlateWidgetIcon(
    ctx,
    pencilIcon,
    {
      x: pencilX + (PENCIL_BUTTON_CSS - PENCIL_ICON_CSS) / 2,
      y: pencilY + (PENCIL_BUTTON_CSS - PENCIL_ICON_CSS) / 2,
      size: PENCIL_ICON_CSS,
    },
    colors.textMuted,
  );

  // `hover:brightness-125`, which a canvas has to paint itself.
  if (hovered) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width / TEXTURE_SCALE, canvas.height / TEXTURE_SCALE);
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return {
    texture,
    // Read back off the canvas so the plane keeps the texture's exact aspect, even
    // where the size was rounded up to a whole pixel.
    widthCss: canvas.width / TEXTURE_SCALE,
    heightCss: canvas.height / TEXTURE_SCALE,
  };
}

/**
 * Bakes the editor into the label's texture: the field's box, the draft inside it,
 * and the caret the keyboard has put there — the same elements the DOM field wore,
 * painted so that the field stands exactly where the label does.
 */
function buildEditorTexture(
  measure: CanvasRenderingContext2D,
  { draft, placeholder, colors, selection, caretOn }: {
    draft: string;
    placeholder: string;
    colors: PlateWidgetColors;
    selection: { start: number; end: number };
    caretOn: boolean;
  },
): { texture: THREE.Texture | null; widthCss: number; heightCss: number } {
  const text = draft || placeholder;
  measure.font = LABEL_FONT;
  const charCss = measure.measureText('0').width;
  // The width the CSS input took from `max(6, len + 2)ch`, in the label's own font.
  const boxWidthCss = Math.ceil(Math.max(EDITOR_MIN_CHARS, (draft || placeholder).length + 2) * charCss);
  const boxHeightCss = LABEL_LINE_HEIGHT_CSS + EDITOR_PADDING_Y_CSS * 2;
  const textXCss = EDITOR_BORDER_CSS + EDITOR_PADDING_X_CSS;
  const textWidthCss = boxWidthCss - textXCss * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(boxWidthCss * TEXTURE_SCALE);
  canvas.height = Math.ceil(boxHeightCss * TEXTURE_SCALE);
  const ctx = canvas.getContext('2d');
  const size = { texture: null, widthCss: boxWidthCss, heightCss: boxHeightCss };
  if (!ctx) return size;
  ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);

  // Stroked on its own centre, so the box is inset by half a border to keep the
  // border inside the texture, as a CSS border box does.
  const box = roundedRectPath(
    EDITOR_BORDER_CSS / 2,
    EDITOR_BORDER_CSS / 2,
    boxWidthCss - EDITOR_BORDER_CSS,
    boxHeightCss - EDITOR_BORDER_CSS,
    EDITOR_RADIUS_CSS,
  );
  // `background: color-mix(in srgb, var(--surface-0), transparent 10%)`.
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = colors.surface0;
  ctx.fill(box);
  ctx.restore();

  // A character of slack keeps the caret off the border as the name is typed.
  const font = fitFontToWidth(measure, LABEL_FONT, text, textWidthCss - charCss);
  measure.font = font;
  const widthTo = (index: number) => measure.measureText(text.slice(0, index)).width;

  // The selection's wash, under the text, the way the browser paints one.
  if (selection.end > selection.start) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = colors.accent;
    ctx.fillRect(
      textXCss + widthTo(selection.start),
      EDITOR_PADDING_Y_CSS,
      widthTo(selection.end) - widthTo(selection.start),
      LABEL_LINE_HEIGHT_CSS,
    );
    ctx.restore();
  }

  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // The placeholder is what the field shows while it is empty, in the muted colour
  // the label itself wears before it is named.
  ctx.fillStyle = draft ? colors.textStrong : colors.textMuted;
  ctx.fillText(text, textXCss, boxHeightCss / 2 + 2);

  // The caret, gone while something is selected — which is when the browser hides
  // its own too.
  if (caretOn && selection.end === selection.start) {
    ctx.fillStyle = colors.textStrong;
    ctx.fillRect(
      textXCss + widthTo(selection.start),
      EDITOR_PADDING_Y_CSS,
      EDITOR_CARET_CSS,
      LABEL_LINE_HEIGHT_CSS,
    );
  }

  // The border last, so the wash and the caret sit inside the field rather than
  // over its edge.
  ctx.save();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = EDITOR_BORDER_CSS;
  ctx.stroke(box);
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return {
    texture,
    // Read back off the canvas so the plane keeps the texture's exact aspect, even
    // where the size was rounded up to a whole pixel.
    widthCss: canvas.width / TEXTURE_SCALE,
    heightCss: canvas.height / TEXTURE_SCALE,
  };
}

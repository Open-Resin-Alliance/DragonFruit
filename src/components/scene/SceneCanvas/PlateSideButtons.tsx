"use client";

import { Html } from '@react-three/drei';
import { Lock, LockOpen, Plus, Trash2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The plate's widgets are looked *at*, not hunted for, so their tooltips wait: a
 * pointer crossing the plate on its way somewhere else should not throw a box over
 * the view. One second is long enough to mean "you stopped here".
 */
const PLATE_WIDGET_TOOLTIP_DELAY_MS = 1000;

type PlateWidgetAnchor = [number, number, number];

/**
 * The buttons beside the build plate: add a plate and lock this one, hanging from the
 * plate's back edge; and the bin, standing on its front edge.
 *
 * Each group is one `Html` because the buttons in it are one column — their spacing
 * is then CSS, not world millimetres. An earlier attempt positioned them as separate
 * anchors and computed the drop in plate millimetres: on a plate viewed at an angle
 * that conversion does not land where the arithmetic says, and the gap came out wrong
 * in both directions. The bin is its own `Html` for the same reason, because one
 * anchor cannot be in two places.
 *
 * The lock is deliberately *not* a document field: a lock is about the session you are
 * working in, not about the file, so it is not written to the scene and does not come
 * back with it.
 *
 * Runs inside the r3f reconciler, where the i18n provider is out of scope, so every
 * string arrives already translated — as the plate's name widget does.
 */
export function PlateSideButtons({
  addLabel,
  addComingSoonTitle,
  locked,
  lockTitle,
  unlockTitle,
  onToggleLock,
  clearTitle,
  clearDisabledTitle,
  clearDisabled,
  onClearPlate,
  columnAnchor,
  clearAnchor,
  facingRotation = 0,
  labelScale = 5,
}: {
  /** Accessible name of the add-plate button, already translated. */
  addLabel: string;
  /** The add-plate button's hover wording, already translated. */
  addComingSoonTitle: string;
  locked: boolean;
  /** Wording shown while the plate is unlocked, i.e. what pressing the lock will do. */
  lockTitle: string;
  /** Wording shown while the plate is locked. */
  unlockTitle: string;
  onToggleLock: () => void;
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
  const LockIcon = locked ? Lock : LockOpen;

  const disabledButtonStyle = {
    borderColor: 'color-mix(in srgb, var(--text-muted), transparent 60%)',
    background: 'color-mix(in srgb, var(--surface-0), transparent 55%)',
    color: 'var(--text-muted)',
    opacity: 0.55,
  } as const;

  return (
    <>
      <Html
        position={columnAnchor}
        transform
        rotation={[0, 0, facingRotation]}
        scale={labelScale}
        zIndexRange={[8, 0]}
        style={{ pointerEvents: 'auto' }}
      >
        {/* `Html` centres content on the anchor: shifting right by half the column's
            width makes the anchor its left edge, and down by half its height makes the
            anchor its top edge. It then starts on the plate's right edge and hangs
            beside the plate with their top edges level. */}
        <div className="flex flex-col items-start gap-3 select-none" style={{ transform: 'translate(50%, 50%)' }}>
          {/* The tooltip goes on a wrapper, not the button: a disabled button emits no
              pointer events of its own, so hovering it would show nothing. */}
          <Tooltip content={addComingSoonTitle} maxWidth={200} delayMs={PLATE_WIDGET_TOOLTIP_DELAY_MS}>
            <button
              type="button"
              disabled
              aria-label={addLabel}
              className="flex h-[104px] w-[104px] cursor-not-allowed items-center justify-center rounded-[5.5px] border transition-[filter,background-color,border-color] duration-150 hover:brightness-110"
              style={disabledButtonStyle}
            >
              <Plus className="h-14 w-14" />
            </button>
          </Tooltip>

          <Tooltip content={locked ? unlockTitle : lockTitle} maxWidth={220} delayMs={PLATE_WIDGET_TOOLTIP_DELAY_MS}>
            <button
              type="button"
              onClick={onToggleLock}
              onPointerDown={(event) => event.stopPropagation()}
              aria-pressed={locked}
              aria-label={locked ? unlockTitle : lockTitle}
              className="flex h-[104px] w-[104px] cursor-pointer items-center justify-center rounded-[5.5px] border transition-[filter,background-color,border-color] duration-150 hover:brightness-110"
              style={locked
                ? {
                  // Locked is a state worth noticing, so it wears the accent rather
                  // than sharing the quiet grey of the inert button above it.
                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
                  color: 'var(--text-strong)',
                }
                : {
                  borderColor: 'color-mix(in srgb, var(--text-muted), transparent 55%)',
                  background: 'color-mix(in srgb, var(--surface-0), transparent 55%)',
                  color: 'var(--text-muted)',
                }}
            >
              <LockIcon className="h-14 w-14" />
            </button>
          </Tooltip>
        </div>
      </Html>

      <Html
        position={clearAnchor}
        transform
        rotation={[0, 0, facingRotation]}
        scale={labelScale}
        zIndexRange={[8, 0]}
        style={{ pointerEvents: 'auto' }}
      >
        {/* Shifting right by half the width makes the anchor the bin's left edge;
            shifting *up* by half its height makes the anchor its bottom edge, which is
            how it stands on the plate's front edge rather than hanging from the back. */}
        <div className="flex select-none" style={{ transform: 'translate(50%, -50%)' }}>
          <Tooltip content={clearDisabled ? clearDisabledTitle : clearTitle} maxWidth={220} delayMs={PLATE_WIDGET_TOOLTIP_DELAY_MS}>
            <button
              type="button"
              disabled={clearDisabled}
              onClick={onClearPlate}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label={clearDisabled ? clearDisabledTitle : clearTitle}
              className={`flex h-[104px] w-[104px] items-center justify-center rounded-[5.5px] border transition-[filter,background-color,border-color] duration-150 ${clearDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:brightness-110'}`}
              style={clearDisabled
                ? disabledButtonStyle
                : {
                  // Destructive, so it announces itself: the danger tone rather than
                  // the quiet grey of the plate's other buttons.
                  borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                  background: 'color-mix(in srgb, #ef4444, var(--surface-0) 88%)',
                  color: '#ef4444',
                }}
            >
              <Trash2 className="h-14 w-14" />
            </button>
          </Tooltip>
        </div>
      </Html>
    </>
  );
}

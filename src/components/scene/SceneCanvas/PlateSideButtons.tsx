"use client";

import { Html } from '@react-three/drei';
import { Lock, LockOpen, Plus } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The plate's widgets are looked *at*, not hunted for, so their tooltips wait: a
 * pointer crossing the plate on its way somewhere else should not throw a box over
 * the view. One second is long enough to mean "you stopped here".
 */
const PLATE_WIDGET_TOOLTIP_DELAY_MS = 1000;

/**
 * The buttons that sit beside the build plate: add a plate, and lock this one.
 *
 * Both live in a single `Html` because they are one column: their spacing is then
 * CSS, not world millimetres. An earlier attempt positioned them as two separate
 * anchors and computed the drop in plate millimetres — on a plate viewed at an
 * angle that conversion does not land where the arithmetic says, and the gap came
 * out wrong in both directions.
 *
 * The lock is deliberately *not* a document field: a lock is about the session you
 * are working in, not about the file, so it is not written to the scene and does
 * not come back with it.
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
  position,
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
  /** World position of the column's anchor point, its top-left corner. */
  position: [number, number, number];
  /** In-plane rotation about Z; see the note in `PlateNameLabel`. */
  facingRotation?: number;
  /** World units per CSS pixel, matching the plate's name widget. */
  labelScale?: number;
}) {
  const LockIcon = locked ? Lock : LockOpen;

  return (
    <Html
      position={position}
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
            style={{
              borderColor: 'color-mix(in srgb, var(--text-muted), transparent 60%)',
              background: 'color-mix(in srgb, var(--surface-0), transparent 55%)',
              color: 'var(--text-muted)',
              opacity: 0.55,
            }}
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
  );
}

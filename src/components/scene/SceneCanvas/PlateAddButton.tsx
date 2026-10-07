"use client";

import { Html } from '@react-three/drei';
import { Plus } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The add-plate button, off the build plate's right edge and laid out exactly like
 * the plate's name widget beside it: flat in world space, anchored by the corner
 * its content grows away from.
 *
 * It is inert until the app grows a second plate — the plate model is single-plate
 * today, so the button says so rather than doing nothing when pressed. Disabled
 * rather than hidden, because the affordance is the point: it shows where plates
 * will come from.
 *
 * Runs inside the r3f reconciler, where the i18n provider is out of scope, so both
 * strings arrive already translated, like the plate's name widget. The tooltip is
 * the app's own, not a native `title`: it portals to the page, so it is not warped
 * by the label's 3D transform.
 */
export function PlateAddButton({
  label,
  comingSoonTitle,
  position,
  facingRotation = 0,
  labelScale = 5,
}: {
  /** Accessible name of the button, already translated. */
  label: string;
  /** The wording shown on hover, already translated. */
  comingSoonTitle: string;
  /** World position of the button's anchor point. */
  position: [number, number, number];
  /** In-plane rotation about Z; see the note in `PlateNameLabel`. */
  facingRotation?: number;
  /** World units per CSS pixel, matching the name widget's size on the plate. */
  labelScale?: number;
}) {
  return (
    <Html
      position={position}
      transform
      rotation={[0, 0, facingRotation]}
      scale={labelScale}
      zIndexRange={[8, 0]}
      style={{ pointerEvents: 'auto' }}
    >
      {/* `Html` centres content on the anchor. Shifting right by half the button's
          width makes the anchor its left edge, so it starts on the plate's right
          edge and grows off it; shifting *down* by half its height makes the anchor
          its top edge, so it hangs beside the plate with their top edges level
          rather than floating above it. */}
      <div className="flex select-none" style={{ transform: 'translate(50%, 50%)' }}>
        {/* The tooltip goes on the wrapper, not the button: a disabled button emits
            no pointer events of its own, so hovering it would show nothing. */}
        <Tooltip content={comingSoonTitle} maxWidth={200}>
          <button
            type="button"
            disabled
            aria-label={label}
            className="flex h-[104px] w-[104px] cursor-not-allowed items-center justify-center rounded-[5.5px] border"
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
      </div>
    </Html>
  );
}

"use client";

/**
 * The Auto Support panel's preset row: the run-policy selector and the Auto-Lift
 * toggle, side by side at 1:1.
 *
 * Both halves are controls over the same decision — the model sits `liftDistance`
 * above the plate or it does not, and that gap is what the generated supports have
 * to span — so they belong on one line rather than in two places a user has to
 * connect. The Auto Support panel is where a run is started; Prepare → Transform →
 * Lift keeps its own control over the same flag, and both write the one state.
 *
 * Presentational: the collection, the active id and the lift flag all arrive as
 * props, which is what lets the row be asserted without a DOM.
 */
import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Button } from '@/components/atoms';
import type { AutoSupportPreset } from '@/supports/Settings/autoSupportPresets';
import { AutoSupportPresetSelect } from './AutoSupportPresetSelect';

/**
 * The toggle's labels. The state is in the words, not in a decoration: the button
 * says which way the flag is set, so it reads the same to someone who cannot tell
 * the accent fill from the quiet one.
 */
const AUTO_LIFT_ON = msg`Auto-Lift ON`;
const AUTO_LIFT_OFF = msg`Auto-Lift OFF`;

/**
 * What the flag does, in the terms an auto-support run cares about. Mirrors the
 * Prepare panel's own hint: lifting reseats the model and clears a manual Z move.
 */
const AUTO_LIFT_HINT = msg`Hold the model clear of the plate, so a support can stand under it. Turns off a manual Z move.`;

/**
 * The standard DragonFruit toggle treatment — the bracing card's quick-pick and
 * the Cut Panel's segmented selector both use it, so a toggle reads the same
 * wherever it appears: the theme accent behind the button while it is on.
 */
const ON_STYLE: React.CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
  color: 'var(--text-strong)',
};

/**
 * Off: the same button, and the same lighter fill the dropdown beside it carries,
 * so the pair reads as one row rather than a filled control next to a dark one.
 */
const OFF_STYLE: React.CSSProperties = {
  background: 'var(--surface-1)',
};

type AutoSupportPresetRowProps = {
  /** The store's collection, as the panel subscribes to it. */
  presets: readonly AutoSupportPreset[];
  /** The store's active preset id. */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** The active preset's own explanation, e.g. a built-in tier's hint. */
  activeHint?: MessageDescriptor;
  /** Auto-lift, the app's one flag for it (`useTransformManager`). */
  autoLift: boolean;
  onAutoLiftChange: (enabled: boolean) => void;
};

export function AutoSupportPresetRow({
  presets,
  activeId,
  onSelect,
  activeHint,
  autoLift,
  onAutoLiftChange,
}: AutoSupportPresetRowProps) {
  const { _ } = useLingui();

  return (
    <div className="flex gap-1.5">
      <div className="min-w-0 flex-1">
        <AutoSupportPresetSelect
          presets={presets}
          activeId={activeId}
          onSelect={onSelect}
          activeHint={activeHint}
        />
      </div>
      {/* A toggle button, in the app's standard shape: `aria-pressed` is the
          pressed state a toggle button carries, and the accent fill is what says it
          is on. The label states the state as well — "Auto-Lift ON" / "Auto-Lift
          OFF" — so the button reads the same to someone who cannot tell the accent
          fill from the quiet one, and so a screenshot of the row is unambiguous. */}
      <Button
        onClick={() => onAutoLiftChange(!autoLift)}
        aria-pressed={autoLift}
        title={_(AUTO_LIFT_HINT)}
        variant="secondary"
        size="auto"
        className="min-w-0 flex-1 !h-8 px-2 text-[11px]"
        style={autoLift ? ON_STYLE : OFF_STYLE}
      >
        <span className="truncate">{_(autoLift ? AUTO_LIFT_ON : AUTO_LIFT_OFF)}</span>
      </Button>
    </div>
  );
}

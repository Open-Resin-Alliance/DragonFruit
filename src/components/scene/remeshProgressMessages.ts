/**
 * Display names for the shrinkwrap (Remesh) phases.
 *
 * The same shape as the mesh-repair stage labels: the engine passes each phase as a fixed code
 * because the report keys on it and it has to stay language-neutral, only the label in the
 * progress sheet is translated, and a phase the map does not know falls back to the raw code
 * rather than rendering blank.
 *
 * Module level on purpose: React Compiler renames locals inside components before the Lingui
 * macro derives the message id.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

const PHASE_LABELS: Record<string, MessageDescriptor> = {
  band_mark: msg`Finding the surface`,
  band_grow: msg`Growing the surface band`,
  band_distance: msg`Measuring distances to the surface`,
  marching: msg`Building the new surface`,
  weld: msg`Joining the new surface`,
  smooth: msg`Smoothing the new surface`,
  orient: msg`Turning faces outward`,
  closing: msg`Closing the new surface`,
  simplify: msg`Simplifying the new surface`,
  closing_after_simplify: msg`Closing the simplified surface`,
};

/**
 * The engine's phase order in `shrink_wrap_with_progress`, which is what the index it reports is a
 * position in. The last two phases are conditional — a run under the triangle budget skips them —
 * so the bar is a fraction of the phases that can run, and it is honest about not being finished
 * until the run reports its last one.
 */
export const REMESH_PHASES: readonly string[] = Object.keys(PHASE_LABELS);

export function translateRemeshPhase(phase: string | undefined, translate: Translate): string {
  if (!phase) {
    return translate(
      msg({ message: 'Starting', comment: 'Remesh progress before the first phase reports in.' }),
    );
  }
  const descriptor = PHASE_LABELS[phase];
  return descriptor ? translate(descriptor) : phase;
}

/** How full the bar is, 0..1, from the 1-based phase index the engine reports. */
export function remeshProgressFraction(phaseIndex: number | undefined): number {
  if (!phaseIndex || phaseIndex < 0) return 0;
  return Math.min(1, phaseIndex / REMESH_PHASES.length);
}

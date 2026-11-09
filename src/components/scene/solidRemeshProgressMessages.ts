/**
 * Display names for the shrink-wrap phases.
 *
 * The engine passes each phase as a fixed code because the report keys on it and it has to stay
 * language-neutral; only the label in the progress sheet is translated, and a phase the map does not
 * know falls back to the raw code rather than rendering blank.
 *
 * Module level on purpose: React Compiler renames locals inside components before the Lingui macro
 * derives the message id.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

const PHASE_LABELS: Record<string, MessageDescriptor> = {
  prepare: msg`Preparing the model`,
  fill: msg`Closing open edges`,
  solid: msg`Rebuilding the surface`,
  shells: msg`Cleaning up`,
};

/**
 * The engine's phase order in `solid_remesh_with_progress`, which is what the index it reports is a
 * position in. All four always run, so the bar reaches the end of a completed pass.
 */
export const SOLID_REMESH_PHASES: readonly string[] = Object.keys(PHASE_LABELS);

export function translateSolidRemeshPhase(phase: string | undefined, translate: Translate): string {
  if (!phase) {
    return translate(
      msg({
        message: 'Starting',
        comment: 'Shrink-wrap progress before the first phase reports in.',
      }),
    );
  }
  const descriptor = PHASE_LABELS[phase];
  return descriptor ? translate(descriptor) : phase;
}

/** How full the bar is, 0..1, from the 1-based phase index the engine reports. */
export function solidRemeshProgressFraction(phaseIndex: number | undefined): number {
  if (!phaseIndex || phaseIndex < 0) return 0;
  return Math.min(1, phaseIndex / SOLID_REMESH_PHASES.length);
}

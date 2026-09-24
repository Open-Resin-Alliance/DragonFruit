/**
 * Display names for the island-scan phases.
 *
 * The engines pass the phase as a fixed English code because they also use it
 * to look up the phase number (`SCAN_PHASES.indexOf`), so the code must stay
 * language-neutral. Only the label shown in the progress bar is translated, and
 * only here — a phase the map does not know falls back to the raw code rather
 * than rendering blank.
 *
 * Module level on purpose: React Compiler renames locals inside components
 * before the Lingui macro derives the message id.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

const PHASE_LABELS: Record<string, MessageDescriptor> = {
  'Slicing': msg`Slicing`,
  'Collecting voxels': msg`Collecting voxels`,
  'Connecting islands': msg`Connecting islands`,
  'Tracking islands': msg`Tracking islands`,
  'Tracking territories': msg`Tracking territories`,
  'Compiling results': msg`Compiling results`,
  // The auto-support run reports its placement pass through the same channel.
  'Placing supports': msg`Placing supports`,
};

export function translateScanPhase(phase: string | undefined, translate: Translate): string {
  if (!phase) return translate(msg({ message: 'Starting', comment: 'Island scan progress before the first phase reports in.' }));
  const descriptor = PHASE_LABELS[phase];
  return descriptor ? translate(descriptor) : phase;
}

/**
 * "Step 2 of 3" for the bar's phase counter.
 *
 * The scan is a sequence of passes and each restarts at zero, so the bar has to
 * say which pass it is on or it looks like it is going backwards. A bare
 * "(2/3)" does not: two numbers with no noun read as debug output. Module level
 * because the message interpolates, and React Compiler renames locals inside
 * components before the Lingui macro derives the id.
 */
export function formatPhaseStep(phaseNumber: number, phaseCount: number, translate: Translate): string {
  return translate(msg`Step ${phaseNumber} of ${phaseCount}`);
}

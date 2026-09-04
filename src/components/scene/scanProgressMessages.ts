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
};

export function translateScanPhase(phase: string | undefined, translate: Translate): string {
  if (!phase) return translate(msg({ message: 'Starting', comment: 'Island scan progress before the first phase reports in.' }));
  const descriptor = PHASE_LABELS[phase];
  return descriptor ? translate(descriptor) : phase;
}

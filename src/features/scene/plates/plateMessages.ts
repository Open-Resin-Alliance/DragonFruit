/**
 * The wording a plate needs, kept at module level on purpose.
 *
 * React Compiler renames locals inside components before the Lingui macro
 * derives the message id, so an interpolation written inside one ends up with an
 * id the compiled catalogue does not contain: a permanent miss that falls back
 * to the raw source and prints `{index}` in production builds. Module-level
 * helpers are outside React Compiler's reach, so their ids stay stable. See
 * `sceneImportMessages.ts` for the same pattern.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

/** What an unnamed plate is called on its own label: "Plate 2". */
export function plateNumberPlaceholder(index: number, translate: Translate): string {
  return translate(msg`Plate ${index}`);
}

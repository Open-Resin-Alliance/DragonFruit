/**
 * Turns an `AutoBraceResult` into the sentence the sidebar shows.
 *
 * The engine reports a status code and its counts; the wording lives here so it
 * can be translated at render time. Module level on purpose, for two reasons:
 * React Compiler renames locals inside components before the Lingui macro
 * derives the message id, and `autoBrace.ts` itself is imported by unit tests
 * that run under tsx with no macro transform — the type import below is erased,
 * so nothing pulls the macro into that graph.
 */

import { msg, plural } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { AutoBraceResult } from './autoBrace';

type Translate = (descriptor: MessageDescriptor) => string;

export function formatAutoBraceStatus(result: AutoBraceResult, translate: Translate): string {
  if (result.status === 'no-eligible-supports') {
    return translate(msg`No eligible supports found for Auto Bracing.`);
  }

  const generated = result.generatedBraceCount;
  const removed = result.removedBraceCount;
  return translate(msg`Auto Brace complete: ${plural(generated, {
    one: '# brace generated',
    other: '# braces generated',
  })}, ${plural(removed, {
    one: '# legacy brace removed',
    other: '# legacy braces removed',
  })}.`);
}

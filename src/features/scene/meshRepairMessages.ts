/**
 * Toasts for the manual mesh repair. Module level for the same React Compiler
 * reason as `sceneImportMessages.ts`.
 */

import { msg, plural } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

export function repairedModelsMessage(names: readonly string[], translate: Translate): string {
  if (names.length === 1) {
    const modelName = names[0];
    return translate(msg`Repaired ${modelName}.`);
  }
  const count = names.length;
  return translate(msg`${plural(count, { one: 'Repaired # model.', other: 'Repaired # models.' })}`);
}

export function repairFailedMessage(message: string, translate: Translate): string {
  return translate(msg`Repair failed: ${message}`);
}

export function repairFailedForModelMessage(modelName: string, message: string, translate: Translate): string {
  return translate(msg`Repair failed for ${modelName}: ${message}`);
}

export function repairCancelledMessage(count: number, translate: Translate): string {
  return translate(msg`${plural(count, {
    one: 'Repair cancelled. The model is unchanged.',
    other: 'Repair cancelled. The models are unchanged.',
  })}`);
}

export function repairStoppedMessage(repaired: number, total: number, translate: Translate): string {
  return translate(msg`Repair stopped. Repaired ${repaired} of ${total} models; the rest are unchanged.`);
}

/**
 * The remesh outcome. Every number arrives already formatted for the locale, so
 * the message is one string with placeholders rather than a concatenation.
 */
export function remeshedMessage(
  inputTriangles: string,
  outputTriangles: string,
  elapsed: string,
  translate: Translate,
): string {
  return translate(msg`Remeshed ${inputTriangles} → ${outputTriangles} triangles in ${elapsed}.`);
}

/**
 * The tetrahedral surfacing outcome. Every number arrives already formatted for the locale, so the
 * message is one string with placeholders rather than a concatenation.
 */
/** The toast for a shrink-wrap run: what it cost, in triangles, and how long it took. */
export function shrinkWrappedMessage(
  inputTriangles: string,
  outputTriangles: string,
  elapsed: string,
  translate: Translate,
): string {
  return translate(
    msg`Shrink-Wrapped ${inputTriangles} → ${outputTriangles} triangles in ${elapsed}.`,
  );
}

export function tetSurfacedMessage(
  inputTriangles: string,
  outputTriangles: string,
  elapsed: string,
  translate: Translate,
): string {
  return translate(
    msg`Remesh: ${inputTriangles} → ${outputTriangles} triangles in ${elapsed}.`,
  );
}

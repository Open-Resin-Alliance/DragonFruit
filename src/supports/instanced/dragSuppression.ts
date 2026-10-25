import { useSyncExternalStore } from 'react';

/**
 * Which primitives a joint-drag gesture draws through the instanced batch
 * instead of their detail renderer.
 *
 * The gesture has to hide the dragged support's joints, adjacent segments and
 * contact cones. It must NOT unmount them: `JointRenderer` registers its GPU
 * pick target while the parent support is selected, and a `ShaftRenderer`
 * subscribes to its own pick id. Unmounting and remounting them around the
 * gesture would churn those registrations and cost a hover/hit frame at both
 * ends of the drag. A `visible={false}` on an already-registered object keeps
 * the registration and removes the draw.
 *
 * That is why this is a store rather than a prop: the three primitives read it
 * where they already read `isSelected`, and the interaction layer only has to
 * say which ids are suppressed for the gesture.
 */

export type SuppressedPrimitiveKind = 'joint' | 'shaft' | 'cone';

export type SuppressedPrimitive = {
  kind: SuppressedPrimitiveKind;
  id: string;
};

const EMPTY: ReadonlySet<string> = new Set();

let suppressed: ReadonlySet<string> = EMPTY;
let version = 0;
const listeners = new Set<() => void>();

function keyOf(kind: SuppressedPrimitiveKind, id: string): string {
  return `${kind}:${id}`;
}

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Suppress one primitive for the gesture.
 *
 * The id is the primitive id the renderers already carry — a joint's `.id`, a
 * segment's `.id`, a contact cone's `.id`.
 */
export function suppressPrimitiveDrag(kind: SuppressedPrimitiveKind, id: string): void {
  const key = keyOf(kind, id);
  if (suppressed.has(key)) return;
  const next = new Set(suppressed);
  next.add(key);
  suppressed = next;
  emit();
}

/** Suppress a set of primitives in one notification, as a drag start does. */
export function suppressPrimitivesForDrag(entries: readonly SuppressedPrimitive[]): void {
  if (entries.length === 0) return;
  const next = new Set(suppressed);
  let changed = false;
  for (const entry of entries) {
    const key = keyOf(entry.kind, entry.id);
    if (next.has(key)) continue;
    next.add(key);
    changed = true;
  }
  if (!changed) return;
  suppressed = next;
  emit();
}

/** Clear the gesture's suppression: every detail primitive draws again. */
export function clearPrimitiveDragSuppression(): void {
  if (suppressed.size === 0) return;
  suppressed = EMPTY;
  emit();
}

/**
 * Suppress exactly what a gesture's drag batch draws, from the slot map it
 * built. The ids are the primitives' own: a joint's id, a segment's id and a
 * contact cone's id — which is the `contactDiskId` its renderer is given.
 */
export function suppressPrimitivesForJointDrag(slotMap: {
  joints: readonly { id: string }[];
  segments: readonly { id: string }[];
  cones: readonly { id: string }[];
}): void {
  suppressPrimitivesForDrag([
    ...slotMap.joints.map((slot) => ({ kind: 'joint' as const, id: slot.id })),
    ...slotMap.segments.map((slot) => ({ kind: 'shaft' as const, id: slot.id })),
    ...slotMap.cones.map((slot) => ({ kind: 'cone' as const, id: slot.id })),
  ]);
}

/** Whether this primitive is drawn by the gesture's batch instead of its renderer. */
export function isPrimitiveDragSuppressed(
  kind: SuppressedPrimitiveKind,
  id: string | null | undefined,
): boolean {
  if (!id || suppressed.size === 0) return false;
  return suppressed.has(keyOf(kind, id));
}

/** The current suppression set, for tests and dev assertions. */
export function suppressedPrimitiveKeys(): ReadonlySet<string> {
  return suppressed;
}

export function subscribePrimitiveDragSuppression(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The snapshot `useSyncExternalStore` compares: it changes when the set does. */
export function getPrimitiveDragSuppressionVersion(): number {
  return version;
}

/** The same value on the server, where no gesture exists. */
export function getPrimitiveDragSuppressionServerVersion(): number {
  return 0;
}

/**
 * Whether the gesture's drag batch draws this primitive instead of its detail
 * renderer. Consumers pass `visible={!suppressed}` — never conditionally skip
 * the renderer, which would tear down its pick registration.
 */
export function usePrimitiveDragSuppressed(
  kind: SuppressedPrimitiveKind,
  id: string | null | undefined,
): boolean {
  useSyncExternalStore(
    subscribePrimitiveDragSuppression,
    getPrimitiveDragSuppressionVersion,
    getPrimitiveDragSuppressionServerVersion,
  );
  return isPrimitiveDragSuppressed(kind, id);
}

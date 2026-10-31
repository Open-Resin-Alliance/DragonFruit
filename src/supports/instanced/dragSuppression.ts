import React, { useSyncExternalStore } from 'react';

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

type DragSuppressionStore = {
  suppressed: ReadonlySet<string>;
  suppressedSupports: ReadonlySet<string>;
  version: number;
  listeners: Set<() => void>;
};

/**
 * The store lives on `globalThis`, not in this module's scope.
 *
 * The drag start runs in `useJointInteraction`/`JointGizmo`, while the
 * primitives that must hide live under the detail renderers — in this app those
 * landed in different lazy chunks, and a chunk can hold its own copy of a module
 * initializer even when it imports the same source. A module-scoped set then
 * meant `suppress…` wrote one copy and `ShaftRenderer` read another, so the
 * detail geometry never hid. One global object makes every importer agree.
 */
const STORE_KEY = '__dragonfruitSupportDragSuppression';

function store(): DragSuppressionStore {
  const target = globalThis as typeof globalThis & {
    [STORE_KEY]?: DragSuppressionStore;
  };
  let current = target[STORE_KEY];
  if (!current) {
    current = { suppressed: new Set<string>(), suppressedSupports: new Set<string>(), version: 0, listeners: new Set() };
    target[STORE_KEY] = current;
  }
  return current;
}

function keyOf(kind: SuppressedPrimitiveKind, id: string): string {
  return `${kind}:${id}`;
}

function emit(): void {
  const current = store();
  current.version += 1;
  for (const listener of current.listeners) listener();
}

/**
 * Suppress one primitive for the gesture.
 *
 * The id is the primitive id the renderers already carry — a joint's `.id`, a
 * segment's `.id`, a contact cone's `.id`.
 */
export function suppressPrimitiveDrag(kind: SuppressedPrimitiveKind, id: string): void {
  const key = keyOf(kind, id);
  const current = store();
  if (current.suppressed.has(key)) return;
  const next = new Set(current.suppressed);
  next.add(key);
  current.suppressed = next;
  emit();
}

/** Suppress every primitive of one support, whatever its segment ids. */
export function suppressSupportForDrag(supportId: string): void {
  const current = store();
  if (current.suppressedSupports.has(supportId)) return;
  const next = new Set(current.suppressedSupports);
  next.add(supportId);
  current.suppressedSupports = next;
  emit();
}

/** Suppress a set of primitives in one notification, as a drag start does. */
export function suppressPrimitivesForDrag(entries: readonly SuppressedPrimitive[]): void {
  if (entries.length === 0) return;
  const current = store();
  const next = new Set(current.suppressed);
  let changed = false;
  for (const entry of entries) {
    const key = keyOf(entry.kind, entry.id);
    if (next.has(key)) continue;
    next.add(key);
    changed = true;
  }
  if (!changed) return;
  current.suppressed = next;
  emit();
}

/** Clear the gesture's suppression: every detail primitive draws again. */
export function clearPrimitiveDragSuppression(): void {
  const current = store();
  if (current.suppressed.size === 0 && current.suppressedSupports.size === 0) return;
  current.suppressed = new Set<string>();
  current.suppressedSupports = new Set<string>();
  emit();
}

/**
 * Suppress exactly what a gesture's drag batch draws, from the slot map it
 * built. The ids are the primitives' own: a joint's id, a segment's id and a
 * contact cone's id — which is the `contactDiskId` its renderer is given.
 */
export function suppressPrimitivesForJointDrag(slotMap: {
  supportId: string;
  joints: readonly { id: string }[];
  segments: readonly { id: string }[];
  cones: readonly { id: string }[];
}): void {
  suppressSupportForDrag(slotMap.supportId);
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
  const current = store();
  if (!id || current.suppressed.size === 0) return false;
  return current.suppressed.has(keyOf(kind, id));
}

/** The current suppression set, for tests and dev assertions. */
export function suppressedPrimitiveKeys(): ReadonlySet<string> {
  return store().suppressed;
}

export function subscribePrimitiveDragSuppression(listener: () => void): () => void {
  const current = store();
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
  };
}

/** The snapshot `useSyncExternalStore` compares: it changes when the set does. */
export function getPrimitiveDragSuppressionVersion(): number {
  return store().version;
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

/** Whether the gesture draws every primitive of this support in its batch. */
export function useSupportDragSuppressed(supportId: string | null | undefined): boolean {
  useSyncExternalStore(
    subscribePrimitiveDragSuppression,
    getPrimitiveDragSuppressionVersion,
    getPrimitiveDragSuppressionServerVersion,
  );
  if (!supportId) return false;
  return store().suppressedSupports.has(supportId);
}

/**
 * The support whose primitives a drag draws through its private batch.
 *
 * Context, not just the external store: the store depends on every chunk
 * importing one module instance, and the opposite happened twice. The provider
 * lives in `SupportRenderer`, which already re-renders when the drag session
 * opens/closes, so a detail renderer cannot miss it.
 *
 * Both gestures share it:
 *
 * - a joint drag sets `supportId` (which hides that support's detail shafts),
 *   `jointIds` and the cones its batch draws;
 * - a contact-disk (tip) drag sets `supportId: null` — nothing of the support's
 *   shaft moves — and only its one cone id.
 *
 * `coneIds` is therefore the union of both gestures; the gestures cannot overlap
 * (different pointer-down targets, and the pointer is captured by one), so at
 * most one of them contributes.
 */
export type DraggedSupportContextValue = {
  /** The support a joint drag draws in its batch, or null for a tip drag. */
  supportId: string | null;
  /** The joint ids the private batch draws for this gesture. */
  jointIds: ReadonlySet<string>;
  /** The contact-cone ids the private batch draws for this gesture. */
  coneIds: ReadonlySet<string>;
};

export const DraggedSupportContext = React.createContext<DraggedSupportContextValue | null>(null);

export function useDraggedSupport(): DraggedSupportContextValue | null {
  return React.useContext(DraggedSupportContext);
}

export function useDraggedSupportId(): string | null {
  return React.useContext(DraggedSupportContext)?.supportId ?? null;
}

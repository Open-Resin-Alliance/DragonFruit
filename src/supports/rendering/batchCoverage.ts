import type { SupportTypeDescriptor } from '../supportTypeRegistry';

/** The batched passes a type can contribute to. */
export type BatchedPass = 'shaft' | 'cone' | 'root';

/** Every pass, for the completeness check over the registry. */
export const BATCHED_PASSES: readonly BatchedPass[] = ['shaft', 'cone', 'root'];

/**
 * Whether the batched pass draws this type in the view being rendered.
 *
 * A simple view *is* the batches: every detail renderer is skipped in it, so a
 * type that reaches none of them shows nothing at all — the stump did, a frustum
 * root under a cone with no `Roots` row and nothing batched. A type's batching
 * flags answer for the full view, where its own renderer draws whatever it does
 * not batch; a simple view has no renderer left to draw it, so there the pass
 * takes whatever the type has.
 */
export function batchesInView(
    pass: BatchedPass,
    descriptor: SupportTypeDescriptor,
    simpleRender: boolean,
): boolean {
    switch (pass) {
        case 'shaft':
            return descriptor.hasSegments && (descriptor.batchesShaft || simpleRender);
        case 'cone':
            return descriptor.batchesContactCones || (simpleRender && descriptor.upper.kind === 'cone');
        case 'root':
            return descriptor.ownsRoot || (simpleRender && descriptor.lower.kind === 'inlineRoot');
    }
}

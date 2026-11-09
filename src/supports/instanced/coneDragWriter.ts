import {
    buildConeDragSlotMap,
    coneDragSlotOf,
    emptyConeDragBatchSlot,
    type BuildConeDragSlotMapOptions,
    type ConeDragSlotMap,
} from './coneDragSlots';
import { fillConeBatchSlot } from './dragSlots';
import { writeConeBodyMatrix, writeConeDiskMatrix, writeConeTipMatrix } from './coneSlotBatch';
import type { ConeBatchSlot } from './coneSlots';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { SupportInstanceBatch } from './supportInstanceBatch';

/**
 * The one gesture-scoped writer a contact-disk (tip) drag draws through.
 *
 * The joint drag's twin (`instanceDragWriter.ts`), one cone smaller. A tip drag
 * on a cone-only type mutates exactly one `ContactCone`, so the whole gesture
 * is:
 *
 * ```
 * beginConeDrag({...})         // once: builds the single-cone slot map, notifies
 * writeConeDragFrame(cone)     // every hit: matrices only, one flush per batch
 * endConeDrag()                // at release: empties the private batches
 * clearConeDragSession()       // one frame later: after the commit render
 * ```
 *
 * Two deliberate differences from the joint writer:
 *
 * 1. **No drop offset.** The preview cone is derived from a world-space hit
 *    against the committed entity, and the detail renderer draws it without an
 *    offset. Adding one here would make the batch disagree with the renderer it
 *    stands in for, which is the one thing this path exists to avoid.
 * 2. **The session lives on `globalThis`.** Its writer entry is the detail
 *    renderer's hook, while the batch and the suppression provider live in
 *    `SupportRenderer` — the same lazy-chunk split that already bit the
 *    suppression store. A module-scoped singleton would let the hook write one
 *    copy and the batch read another.
 *
 * The session survives `endConeDrag` until `clearConeDragSession`, so the commit
 * can read what the operator last saw.
 */

/** The batches one mounted cone batch draws through. */
export type ConeDragBatchHandles = {
    /** Cone body bucket key to batch. */
    coneBodies?: ReadonlyMap<string, SupportInstanceBatch> | null;
    coneTips?: SupportInstanceBatch | null;
    coneDisks?: SupportInstanceBatch | null;
    /** The nib depth the scene's cone batch would use, from the material profile. */
    resolvePenetration?: (slot: ConeBatchSlot) => number;
};

export type ConeDragSession = {
    /**
     * Increments once per `beginConeDrag`. The batch component keys its resource
     * build on it, so a new gesture never reuses buffers sized for the old one.
     */
    readonly generation: number;
    readonly slotMap: ConeDragSlotMap;
    /** The newest preview cone; the commit reads it through the hook's preview. */
    lastPreview: ContactCone | null;
    /** True once the release handler has ended the gesture; frames are refused. */
    ended: boolean;
};

type ConeDragStore = {
    generation: number;
    session: ConeDragSession | null;
    registrations: Set<ConeDragBatchHandles>;
    listeners: Set<() => void>;
    scheduledClear: boolean;
};

/**
 * The store lives on `globalThis` for the reason above: the writer entry and
 * the batch are mounted by different lazy chunks in this app, and a chunk can
 * hold its own copy of a module initializer even when it imports the same
 * source.
 */
const STORE_KEY = '__dragonfruitContactConeDragSession';

function store(): ConeDragStore {
    const target = globalThis as typeof globalThis & {
        [STORE_KEY]?: ConeDragStore;
    };
    let current = target[STORE_KEY];
    if (!current) {
        current = {
            generation: 0,
            session: null,
            registrations: new Set(),
            listeners: new Set(),
            scheduledClear: false,
        };
        target[STORE_KEY] = current;
    }
    return current;
}

function emit(): void {
    for (const listener of store().listeners) listener();
}

/** The current session, or null. A stable identity until begin/end/clear. */
export function getConeDragSession(): ConeDragSession | null {
    return store().session;
}

/** The same value on the server: there is no gesture outside the client. */
export function getConeDragSessionServerSnapshot(): ConeDragSession | null {
    return null;
}

export function subscribeConeDragSession(listener: () => void): () => void {
    const current = store();
    current.listeners.add(listener);
    return () => {
        current.listeners.delete(listener);
    };
}

/**
 * Open a session for this gesture.
 *
 * Returns the slot map, or null when the gesture must stay on the detail path
 * (see `buildConeDragSlotMap`). Null is silent: the caller keeps publishing the
 * legacy preview and nothing is hidden.
 *
 * No frame is written here: batches register themselves as they mount, and
 * `registerConeDragBatch` writes the session's current frame before that commit
 * paints. A batch still registered from a previous gesture belongs to a mount
 * that is about to unmount.
 */
export function beginConeDrag(options: BuildConeDragSlotMapOptions): ConeDragSlotMap | null {
    const slotMap = buildConeDragSlotMap(options);
    if (!slotMap) return null;

    const current = store();
    current.generation += 1;
    current.session = {
        generation: current.generation,
        slotMap,
        lastPreview: options.cone,
        ended: false,
    };

    emit();
    return slotMap;
}

/**
 * Write one frame from a preview cone.
 *
 * Everything but the profile's kind — which is fixed for the gesture, because
 * the drag re-aims the cone and re-measures its length, never its diameters —
 * is re-derived from `cone` with the same helpers the scene batches use.
 *
 * Throws when there is no session or the gesture already ended: a frame after
 * release is a bug in the caller, not a frame to drop silently.
 */
export function writeConeDragFrame(cone: ContactCone): void {
    const current = store();
    const session = current.session;
    if (!session) throw new Error('writeConeDragFrame: no cone drag session');
    if (session.ended) throw new Error('writeConeDragFrame: the session has ended');

    session.lastPreview = cone;

    const touched = new Set<SupportInstanceBatch>();
    for (const handles of current.registrations) {
        collectConeDragWrites(session, handles, touched);
    }
    flushBatches(touched);
}

/**
 * End the gesture: no further frames, and every private instance is emptied.
 *
 * Emptying the batches here (not at clear) is what makes the release frame
 * correct: the detail cone is switched back on in the same React commit, and an
 * instance left behind would draw the cone twice for a frame.
 *
 * The session itself survives so a commit can still read the preview;
 * `clearConeDragSession` releases it one frame later.
 */
export function endConeDrag(): void {
    const current = store();
    const session = current.session;
    if (!session || session.ended) return;
    // A new object, not a mutation: the batch subscribes to the session
    // identity, and it has to re-render (and stop drawing) on this transition.
    current.session = { ...session, ended: true };

    const touched = new Set<SupportInstanceBatch>();
    for (const handles of current.registrations) {
        if (handles.coneBodies) {
            for (const batch of handles.coneBodies.values()) emptyPrivateBatch(batch, touched);
        }
        emptyPrivateBatch(handles.coneTips, touched);
        emptyPrivateBatch(handles.coneDisks, touched);
    }
    flushBatches(touched);

    emit();
}

/**
 * Release the session, one frame after the commit render.
 *
 * No suppression store to clear: a tip drag hides exactly one cone through
 * `DraggedSupportContext`, and the `ended` session above is what un-hides it in
 * the same commit as the store write. The external store stays untouched, so a
 * tip drag can never clear (or be cleared by) the joint drag's own suppression.
 */
export function clearConeDragSession(): void {
    const current = store();
    if (!current.session) return;
    current.session = null;
    emit();
}

/**
 * Schedule `clearConeDragSession` for the next frame — the release path's one
 * call. The release handler writes the store and ends the session
 * synchronously, so that commit has rendered by the next frame; clearing in the
 * handler itself would release the session a frame early.
 */
export function clearConeDragSessionAfterFrame(): void {
    const current = store();
    const scheduledGeneration = current.session?.generation ?? null;
    if (scheduledGeneration === null || current.scheduledClear) return;
    current.scheduledClear = true;
    const run = () => {
        current.scheduledClear = false;
        // A new gesture can begin inside the frame this was scheduled for (a
        // release and the next press in one tick). Clearing by generation keeps
        // that gesture's session alive.
        if (current.session?.generation !== scheduledGeneration) return;
        clearConeDragSession();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
}

/** The last preview cone, for a commit that reads what the operator saw. */
export function getLastConeDragPreview(): ContactCone | null {
    return store().session?.lastPreview ?? null;
}

/**
 * Register a mounted batch set. Returns its disposer.
 *
 * Registration writes the session's current frame immediately: the batch mounts
 * a commit after the gesture began, so without it the first paint would show
 * the instance at identity (a unit shape at the origin) until the next hit.
 */
export function registerConeDragBatch(handles: ConeDragBatchHandles): () => void {
    const current = store();
    current.registrations.add(handles);

    const session = current.session;
    if (session && !session.ended && session.lastPreview) {
        const touched = new Set<SupportInstanceBatch>();
        try {
            collectConeDragWrites(session, handles, touched);
            flushBatches(touched);
        } catch (error) {
            // A batch that cannot hold the session's instance must not stay in
            // the registry: every later frame would throw inside the render loop.
            current.registrations.delete(handles);
            throw error;
        }
    }

    return () => {
        current.registrations.delete(handles);
    };
}

/** The number of mounted handle sets; exposed for the mount/unmount assertion. */
export function coneDragBatchRegistrationCount(): number {
    return store().registrations.size;
}

function emptyPrivateBatch(
    batch: SupportInstanceBatch | null | undefined,
    touched: Set<SupportInstanceBatch>,
): void {
    if (!batch) return;
    if (batch.count === 0) return;
    // Shrinking only: the data word and ratio are never appended here.
    batch.resizeTo(0, 0, 1);
    touched.add(batch);
}

function flushBatches(batches: Iterable<SupportInstanceBatch>): void {
    for (const batch of batches) batch.flush();
}

/** One cone slot: a frame is synchronous and never re-enters. */
const scratchConeSlot: ConeBatchSlot = emptyConeDragBatchSlot();

/**
 * Write this handle set's instances from the session's preview.
 *
 * Collected into `touched` rather than flushed here so a frame split across
 * registrations (a StrictMode double registration) uploads each batch once.
 */
function collectConeDragWrites(
    session: ConeDragSession,
    handles: ConeDragBatchHandles,
    touched: Set<SupportInstanceBatch>,
): void {
    const cone = session.lastPreview;
    if (!cone) return;

    const slotMap = session.slotMap;
    const slot = coneDragSlotOf(slotMap);
    if (!slot) return;

    const bodyBatches = handles.coneBodies;
    const tipBatch = handles.coneTips;
    const diskBatch = handles.coneDisks;
    if (!bodyBatches && !tipBatch && !diskBatch) return;

    // A degenerate normal drops the frame: the axis quaternion would be NaN.
    // The previous frame stays on screen rather than the instance collapsing.
    if (!fillConeBatchSlot(scratchConeSlot, cone, slotMap.supportId, slotMap.modelId)) return;

    const bodyBatch = bodyBatches?.get(slot.bodyKey);
    if (bodyBatch) {
        writeConeBodyMatrix(bodyBatch, slot.bodyInstance, scratchConeSlot);
        touched.add(bodyBatch);
    }
    if (tipBatch) {
        writeConeTipMatrix(tipBatch, slot.tipInstance, scratchConeSlot);
        touched.add(tipBatch);
    }
    if (slot.diskInstance !== undefined && diskBatch) {
        const penetration = handles.resolvePenetration?.(scratchConeSlot)
            ?? scratchConeSlot.penetrationMm;
        writeConeDiskMatrix(diskBatch, slot.diskInstance, scratchConeSlot, penetration);
        touched.add(diskBatch);
    }
}

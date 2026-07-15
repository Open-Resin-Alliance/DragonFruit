import {
    getSnapshot,
    updateTrunk,
    updateBranch,
    updateLeaf,
    updateAnchor,
    updateStick,
    updateTwig,
} from '../../state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { CONTACT_FACE_MAX_RATIO, CONTACT_FACE_MIN_RATIO } from './contactDiskUtils';

/** Normalize the oval angle into [0, π) — an ellipse is 180°-symmetric. */
export function normalizeContactFaceAngle(angleRad: number): number {
    if (!Number.isFinite(angleRad)) return 0;
    const wrapped = angleRad % Math.PI;
    return wrapped < 0 ? wrapped + Math.PI : wrapped;
}

/**
 * Commit an oval contact-face shape (squish ratio + rotation) onto whichever
 * support owns the given contact disk/cone id — trunk, branch, leaf, anchor,
 * stick (A/B) or twig (A/B). Records a single undo entry.
 *
 * Returns false when the id resolves to no owner (nothing mutated).
 */
export function commitContactFaceShape(contactId: string, ratioIn: number, angleRadIn: number): boolean {
    if (!contactId || !Number.isFinite(ratioIn)) return false;
    const contactFaceRatio = Math.min(CONTACT_FACE_MAX_RATIO, Math.max(CONTACT_FACE_MIN_RATIO, ratioIn));
    const contactFaceAngleRad = normalizeContactFaceAngle(angleRadIn);
    const shape = { contactFaceRatio, contactFaceAngleRad };

    const before = captureSupportEditSnapshot();
    const state = getSnapshot();

    const finish = (): true => {
        pushSupportEditHistory('Reshape contact face', before, captureSupportEditSnapshot());
        return true;
    };

    for (const trunk of Object.values(state.trunks)) {
        if (trunk.contactCone?.id === contactId) {
            updateTrunk({ ...trunk, contactCone: { ...trunk.contactCone, ...shape } });
            return finish();
        }
    }
    for (const branch of Object.values(state.branches)) {
        if (branch.contactCone?.id === contactId) {
            updateBranch({ ...branch, contactCone: { ...branch.contactCone, ...shape } });
            return finish();
        }
    }
    for (const leaf of Object.values(state.leaves)) {
        if (leaf.contactCone?.id === contactId) {
            updateLeaf({ ...leaf, contactCone: { ...leaf.contactCone, ...shape } });
            return finish();
        }
    }
    for (const anchor of Object.values(state.anchors)) {
        if (anchor.contactCone?.id === contactId) {
            updateAnchor({ ...anchor, contactCone: { ...anchor.contactCone, ...shape } });
            return finish();
        }
    }
    for (const stick of Object.values(state.sticks)) {
        if (stick.contactConeA?.id === contactId) {
            updateStick({ ...stick, contactConeA: { ...stick.contactConeA, ...shape } });
            return finish();
        }
        if (stick.contactConeB?.id === contactId) {
            updateStick({ ...stick, contactConeB: { ...stick.contactConeB, ...shape } });
            return finish();
        }
    }
    for (const twig of Object.values(state.twigs)) {
        if (twig.contactDiskA?.id === contactId) {
            updateTwig({ ...twig, contactDiskA: { ...twig.contactDiskA, ...shape } });
            return finish();
        }
        if (twig.contactDiskB?.id === contactId) {
            updateTwig({ ...twig, contactDiskB: { ...twig.contactDiskB, ...shape } });
            return finish();
        }
    }

    return false;
}

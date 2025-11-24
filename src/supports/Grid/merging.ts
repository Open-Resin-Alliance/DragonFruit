import * as THREE from 'three';
import { SupportInstance, SupportSettings } from '../types';
import { generateSupportId } from '../state';
import { snapToTrunk } from '../BranchSupports/snapping/snapToTrunk';
import { regenerateBranchJoints } from '../BranchSupports/createBranch';

/**
 * Snaps a position to the nearest grid intersection on the XY plane.
 */
export function snapToGrid(position: { x: number; y: number; z: number }, spacingMm: number): { x: number; y: number; z: number } {
    if (spacingMm <= 0) return position;
    const x = Math.round(position.x / spacingMm) * spacingMm;
    const y = Math.round(position.y / spacingMm) * spacingMm;
    return { x, y, z: position.z };
}

/**
 * Finds all supports that share the same base position (within a small tolerance).
 */
export function findSupportsAtBase(
    position: { x: number; y: number; z: number },
    supports: SupportInstance[],
    toleranceMm: number = 0.1
): SupportInstance[] {
    return supports.filter((s) => {
        const dx = s.base.x - position.x;
        const dy = s.base.y - position.y;
        return Math.sqrt(dx * dx + dy * dy) < toleranceMm;
    });
}

/**
 * Result of a merge operation.
 */
export interface MergeResult {
    supportToAdd: SupportInstance;
    supportsToUpdate: SupportInstance[];
}

/**
 * Snaps the support base to the grid while keeping the tip fixed on the model.
 */
export function snapSupportToGrid(support: SupportInstance, spacingMm: number): SupportInstance {
    const snappedBase = snapToGrid(support.base, spacingMm);

    if (snappedBase.x === support.base.x && snappedBase.y === support.base.y) {
        return support;
    }

    const newBase = { ...support.base, x: snappedBase.x, y: snappedBase.y };
    const newTip = { ...support.tip };
    let newJoints = support.joints ? [...support.joints] : [];

    if (newJoints.length === 0) {
        newJoints.push({
            id: `${support.id}-joint-0-${Date.now()}`,
            position: { x: newTip.x, y: newTip.y, z: newTip.z },
            ballDiameterMm: support.settings.mid.diameterMm + 0.1,
            order: 0,
            isTipJoint: true,
            updatedAt: Date.now()
        });
    }

    if (newJoints.length === 1) {
        const tipJoint = newJoints[0];
        const height = tipJoint.position.z - newBase.z;
        const kneeOffset = Math.min(10, height * 0.3);
        const kneeZ = tipJoint.position.z - kneeOffset;

        const kneeJoint = {
            id: `${generateSupportId()}-joint-knee-${Date.now()}`,
            position: { x: newBase.x, y: newBase.y, z: kneeZ },
            ballDiameterMm: tipJoint.ballDiameterMm,
            order: 1,
            isTipJoint: false,
            updatedAt: Date.now()
        };
        newJoints.push(kneeJoint);
    } else {
        newJoints = newJoints.map((j, index) => {
            if (index === 0) return j;
            return {
                ...j,
                position: { ...j.position, x: newBase.x, y: newBase.y }
            };
        });
    }

    return {
        ...support,
        tip: newTip,
        base: newBase,
        joints: newJoints
    };
}

/**
 * Handles grid merging logic for support placement.
 */
export function calculateGridMerge(
    candidate: SupportInstance,
    allSupports: SupportInstance[],
    gridSpacingMm: number
): MergeResult {
    const candidateWithSnappedBase = snapSupportToGrid(candidate, gridSpacingMm);
    const snappedBase = candidateWithSnappedBase.base;

    const existingAtLoc = findSupportsAtBase(snappedBase, allSupports);

    const relatedBranches = allSupports.filter(s =>
        s.parentBaseId && existingAtLoc.some(parent => parent.id === s.parentBaseId)
    );

    if (existingAtLoc.length === 0) {
        return {
            supportToAdd: candidateWithSnappedBase,
            supportsToUpdate: [],
        };
    }

    const roots = [...existingAtLoc, candidateWithSnappedBase];

    let maxDiameter = 0;
    roots.forEach((s) => {
        if (s.settings.mid.diameterMm > maxDiameter) {
            maxDiameter = s.settings.mid.diameterMm;
        }
    });

    let tallestSupport = roots[0];
    let maxZ = -Infinity;

    roots.forEach((s) => {
        if (s.tip.z > maxZ) {
            maxZ = s.tip.z;
            tallestSupport = s;
        }
    });

    const supportsToUpdate: SupportInstance[] = [];
    let finalCandidate = candidateWithSnappedBase;
    const isCandidate = (s: SupportInstance) => s.id === candidate.id;

    const calculateBranchConnection = (trunkId: string, branchTip: { x: number, y: number, z: number }) => {
        const MIN_BRANCH_ANGLE_DEG = 45;

        // Get trunk from allSupports to get current joints
        let trunk = allSupports.find(s => s.id === trunkId);
        if (!trunk) trunk = tallestSupport;

        const trunkForSnapping: SupportInstance = {
            ...trunk,
            base: { ...trunk.base, z: 0 },
            parentBaseId: null,
            joints: trunk.joints || []
        };

        console.log('[Grid] Snap to trunk:', trunkId, 'joints:', trunk.joints?.length || 0);
        const snapResult = snapToTrunk(branchTip, [trunkForSnapping], Infinity);

        if (!snapResult) {
            console.error('[Grid] SNAP FAILED');
        } else {
            console.log('[Grid] Snapped to:', snapResult.position);
        }

        if (snapResult) {
            const dx = branchTip.x - snapResult.position.x;
            const dy = branchTip.y - snapResult.position.y;
            const horizontalDist = Math.sqrt(dx * dx + dy * dy);
            const minVerticalDist = horizontalDist * Math.tan(MIN_BRANCH_ANGLE_DEG * Math.PI / 180);
            const maxAllowedZ = branchTip.z - minVerticalDist;

            if (snapResult.position.z > maxAllowedZ) {
                console.log('[Grid] Adjusting from Z:', snapResult.position.z, 'to', maxAllowedZ);
                const adjustedResult = snapToTrunk(
                    { x: branchTip.x, y: branchTip.y, z: maxAllowedZ },
                    [trunkForSnapping],
                    Infinity
                );

                if (adjustedResult && adjustedResult.position.z <= maxAllowedZ) {
                    return adjustedResult.position;
                }

                // Fallback: clamp Z
                console.warn('[Grid] Using Z-clamped position');
                return {
                    x: snapResult.position.x,
                    y: snapResult.position.y,
                    z: maxAllowedZ
                };
            }

            return snapResult.position;
        }

        // Complete fallback
        console.error('[Grid] USING FALLBACK');
        return {
            x: trunk.base.x,
            y: trunk.base.y,
            z: Math.max(trunk.base.z, Math.min(trunk.tip.z, branchTip.z - 5))
        };
    };

    const supportsToProcess = [...existingAtLoc, ...relatedBranches];

    supportsToProcess.forEach((existing) => {
        let updated = { ...existing };
        let changed = false;

        if (existing.id === tallestSupport.id) {
            if (updated.parentBaseId !== null) {
                updated.parentBaseId = null;
                changed = true;
            }
            if (updated.settings.mid.diameterMm !== maxDiameter) {
                updated.settings = {
                    ...updated.settings,
                    mid: {
                        ...updated.settings.mid,
                        diameterMm: maxDiameter,
                    },
                };
                changed = true;
            }
            if (Math.abs(updated.base.z - candidateWithSnappedBase.base.z) > 0.01) {
                updated.base = { ...updated.base, z: candidateWithSnappedBase.base.z };
                changed = true;
            }
        } else {
            if (updated.parentBaseId !== tallestSupport.id) {
                updated.parentBaseId = tallestSupport.id;
                changed = true;
            }

            const newBase = calculateBranchConnection(tallestSupport.id, updated.tip);

            const dist = Math.sqrt(
                Math.pow(updated.base.x - newBase.x, 2) +
                Math.pow(updated.base.y - newBase.y, 2) +
                Math.pow(updated.base.z - newBase.z, 2)
            );

            if (dist > 0.01) {
                updated.base = newBase;
                changed = true;
            }

            const lastJoint = updated.joints && updated.joints.length > 0 ? updated.joints[updated.joints.length - 1] : null;
            const needsJointUpdate = !lastJoint || lastJoint.type !== 'branch' || lastJoint.lockedToSupportId !== tallestSupport.id || changed;

            if (needsJointUpdate) {
                updated.joints = regenerateBranchJoints(
                    updated,
                    updated.base,
                    tallestSupport.id,
                    tallestSupport.settings.mid.diameterMm
                );
                changed = true;
            }
        }

        if (changed) {
            supportsToUpdate.push(updated);
        }
    });

    if (isCandidate(tallestSupport)) {
        finalCandidate.parentBaseId = null;
        finalCandidate.settings = {
            ...finalCandidate.settings,
            mid: {
                ...finalCandidate.settings.mid,
                diameterMm: maxDiameter,
            },
        };
    } else {
        finalCandidate.parentBaseId = tallestSupport.id;
        finalCandidate.base = calculateBranchConnection(tallestSupport.id, finalCandidate.tip);
        finalCandidate.joints = regenerateBranchJoints(
            finalCandidate,
            finalCandidate.base,
            tallestSupport.id,
            tallestSupport.settings.mid.diameterMm
        );
    }

    return {
        supportToAdd: finalCandidate,
        supportsToUpdate,
    };
}

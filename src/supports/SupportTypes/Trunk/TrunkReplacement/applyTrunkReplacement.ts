import type { Branch, Joint, Knot, Roots, SupportState, Trunk, Vec3 } from '../../../types';
import { addBranch, addKnot, addLeaf, addRoot, addTrunk, getSnapshot, removeBranch, removeLeaf, removeTrunk, updateBranch, updateKnot, updateTrunk } from '../../../state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_REPLACE_TRUNK } from '../../../history/actionTypes';
import type { SupportReplaceTrunkPayload } from '../../../history/actionTypes';
import { buildTrunkData } from '../trunkBuilder';
import { buildBranchData } from '../../Branch/branchBuilder';
import { buildLeafData } from '../../Leaf/leafBuilder';
import { getTrunkSegmentEndpoints } from '../../../SupportPrimitives/Knot/knotUtils';
import { getFinalSocketPosition } from '../../../SupportPrimitives/ContactCone/contactConeUtils';
import { getSettingsSnapshot } from '../../../Settings/state';
import { getJointDiameter } from '../../../constants';
import type { TrunkReplacementPlan } from './types';
import { computeAndApplyTrunkDiameterProfile } from './maxConnectedDiameter';

function distSq(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function satisfiesMinAngleFromHorizontal(tipPos: Vec3, knotPos: Vec3, minAngleDeg: number): boolean {
    const dx = tipPos.x - knotPos.x;
    const dy = tipPos.y - knotPos.y;
    const horizontal = Math.sqrt(dx * dx + dy * dy);
    const vertical = tipPos.z - knotPos.z;
    if (vertical <= 0) return false;

    const minAngleRad = (minAngleDeg * Math.PI) / 180;
    const requiredVertical = horizontal * Math.tan(minAngleRad);
    return vertical >= requiredVertical;
}

function applyDiameterToBranch(branch: Branch, diameterMm: number): Branch {
    if (!Number.isFinite(diameterMm) || diameterMm <= 0) return branch;

    const jointDiameter = getJointDiameter(diameterMm);
    const jointById = new Map<string, number>();

    const nextSegments = branch.segments.map((seg) => {
        const nextTopJoint = seg.topJoint
            ? {
                ...seg.topJoint,
                diameter: jointById.get(seg.topJoint.id) ?? jointDiameter,
            }
            : seg.topJoint;

        if (nextTopJoint) jointById.set(nextTopJoint.id, nextTopJoint.diameter);

        const nextBottomJoint = seg.bottomJoint
            ? {
                ...seg.bottomJoint,
                diameter: jointById.get(seg.bottomJoint.id) ?? jointDiameter,
            }
            : seg.bottomJoint;

        if (nextBottomJoint) jointById.set(nextBottomJoint.id, nextBottomJoint.diameter);

        return {
            ...seg,
            diameter: diameterMm,
            topJoint: nextTopJoint,
            bottomJoint: nextBottomJoint,
        };
    });

    return {
        ...branch,
        segments: nextSegments,
    };
}

function applySocketAndMidJointPositionsForBranch(args: {
    branch: Branch;
    parentKnotPos: Vec3;
}): Branch {
    const { branch, parentKnotPos } = args;

    const cone = branch.contactCone;
    const socketJointId = cone?.socketJointId;
    if (!cone || !socketJointId) return branch;

    const socketPos = getFinalSocketPosition(cone);

    const seg0 = branch.segments[0];
    const seg1 = branch.segments[1];
    const midJointId = seg0?.topJoint?.id ?? seg1?.bottomJoint?.id;

    const midPos: Vec3 = {
        x: (parentKnotPos.x + socketPos.x) / 2,
        y: (parentKnotPos.y + socketPos.y) / 2,
        z: (parentKnotPos.z + socketPos.z) / 2,
    };

    const nextSegments = branch.segments.map((seg) => {
        const nextTopJoint = seg.topJoint
            ? {
                ...seg.topJoint,
                pos:
                    seg.topJoint.id === socketJointId
                        ? socketPos
                        : midJointId && seg.topJoint.id === midJointId
                            ? midPos
                            : seg.topJoint.pos,
            }
            : seg.topJoint;

        const nextBottomJoint = seg.bottomJoint
            ? {
                ...seg.bottomJoint,
                pos:
                    seg.bottomJoint.id === socketJointId
                        ? socketPos
                        : midJointId && seg.bottomJoint.id === midJointId
                            ? midPos
                            : seg.bottomJoint.pos,
            }
            : seg.bottomJoint;

        return nextTopJoint === seg.topJoint && nextBottomJoint === seg.bottomJoint
            ? seg
            : {
                ...seg,
                topJoint: nextTopJoint,
                bottomJoint: nextBottomJoint,
            };
    });

    return {
        ...branch,
        segments: nextSegments,
    };
}

function adjustBranchForNewParentKnot(branch: Branch, newParentKnot: Knot): Branch {
    if (branch.segments.length < 2) {
        return { ...branch, parentKnotId: newParentKnot.id };
    }

    const seg0 = branch.segments[0];
    const seg1 = branch.segments[1];

    const socketPos = seg1.topJoint?.pos ?? seg0.topJoint?.pos;
    if (!socketPos) {
        return { ...branch, parentKnotId: newParentKnot.id };
    }

    const midPos: Vec3 = {
        x: (newParentKnot.pos.x + socketPos.x) / 2,
        y: (newParentKnot.pos.y + socketPos.y) / 2,
        z: (newParentKnot.pos.z + socketPos.z) / 2,
    };

    const baseMidJoint: Joint | undefined = seg0.topJoint ?? seg1.bottomJoint;
    const midJoint: Joint = baseMidJoint
        ? { ...baseMidJoint, pos: midPos }
        : { id: crypto.randomUUID(), pos: midPos, diameter: seg0.diameter };

    const nextSeg0 = {
        ...seg0,
        topJoint: midJoint,
    };

    const nextSeg1 = {
        ...seg1,
        bottomJoint: midJoint,
    };

    const nextSegments = [nextSeg0, nextSeg1, ...branch.segments.slice(2)];

    return {
        ...branch,
        parentKnotId: newParentKnot.id,
        segments: nextSegments,
    };
}

function projectPointOntoSegment(point: Vec3, start: Vec3, end: Vec3): { point: Vec3; t: number } {
    const vx = end.x - start.x;
    const vy = end.y - start.y;
    const vz = end.z - start.z;

    const wx = point.x - start.x;
    const wy = point.y - start.y;
    const wz = point.z - start.z;

    const vv = vx * vx + vy * vy + vz * vz;
    const rawT = vv <= 0.0000001 ? 0 : (wx * vx + wy * vy + wz * vz) / vv;
    const t = Math.min(1, Math.max(0, rawT));

    return {
        t,
        point: {
            x: start.x + vx * t,
            y: start.y + vy * t,
            z: start.z + vz * t,
        },
    };
}

function shiftTrunkToRootXY(trunk: Trunk, root: Roots, targetX: number, targetY: number): { trunk: Trunk; root: Roots } {
    const dx = targetX - root.transform.pos.x;
    const dy = targetY - root.transform.pos.y;

    if (dx === 0 && dy === 0) return { trunk, root };

    const socketJointId = trunk.contactCone?.socketJointId;

    const nextSegments = trunk.segments.map((seg) => {
        const nextTopJoint =
            seg.topJoint && (!socketJointId || seg.topJoint.id !== socketJointId)
                ? {
                    ...seg.topJoint,
                    pos: {
                        ...seg.topJoint.pos,
                        x: seg.topJoint.pos.x + dx,
                        y: seg.topJoint.pos.y + dy,
                    },
                }
                : seg.topJoint;

        const nextBottomJoint =
            seg.bottomJoint && (!socketJointId || seg.bottomJoint.id !== socketJointId)
                ? {
                    ...seg.bottomJoint,
                    pos: {
                        ...seg.bottomJoint.pos,
                        x: seg.bottomJoint.pos.x + dx,
                        y: seg.bottomJoint.pos.y + dy,
                    },
                }
                : seg.bottomJoint;

        if (nextTopJoint === seg.topJoint && nextBottomJoint === seg.bottomJoint) return seg;

        return {
            ...seg,
            topJoint: nextTopJoint,
            bottomJoint: nextBottomJoint,
        };
    });

    const nextRoot: Roots = {
        ...root,
        transform: {
            ...root.transform,
            pos: {
                ...root.transform.pos,
                x: targetX,
                y: targetY,
            },
        },
    };

    return {
        root: nextRoot,
        trunk: {
            ...trunk,
            segments: nextSegments,
        },
    };
}

function createAttachmentKnotOnTrunk(args: {
    trunk: Trunk;
    root: Roots;
    referencePos: Vec3;
    tipPos: Vec3;
    minAngleDeg: number;
    attachStepMm: number;
}): Knot | null {
    const { trunk, root, referencePos, tipPos, minAngleDeg, attachStepMm } = args;

    const epsilonZ = 0.0001;

    // Iterate segments from top to bottom.
    for (let segIndex = trunk.segments.length - 1; segIndex >= 0; segIndex--) {
        const seg = trunk.segments[segIndex];
        const endpoints = getTrunkSegmentEndpoints(trunk, seg, segIndex, root);
        if (!seg || !endpoints) continue;

        const approxLen = Math.max(
            0.001,
            Math.sqrt(
                Math.pow(endpoints.end.x - endpoints.start.x, 2) +
                Math.pow(endpoints.end.y - endpoints.start.y, 2) +
                Math.pow(endpoints.end.z - endpoints.start.z, 2)
            )
        );

        const step = Math.max(0.0005, attachStepMm / approxLen);

        // Start at the point on this segment closest to the old reference and walk downward
        // until we find a valid attachment.
        const proj = projectPointOntoSegment(referencePos, endpoints.start, endpoints.end);
        for (let t = proj.t; t >= 0; t -= step) {
            const pos = {
                x: endpoints.start.x + (endpoints.end.x - endpoints.start.x) * t,
                y: endpoints.start.y + (endpoints.end.y - endpoints.start.y) * t,
                z: endpoints.start.z + (endpoints.end.z - endpoints.start.z) * t,
            };

            // Must be below tip (avoid knot-above-tip islands)
            if (pos.z > tipPos.z - epsilonZ) continue;

            // Must be steep enough (avoid near-horizontal shafts)
            if (!satisfiesMinAngleFromHorizontal(tipPos, pos, minAngleDeg)) continue;

            return {
                id: crypto.randomUUID(),
                parentShaftId: seg.id,
                t,
                pos,
                diameter: seg.diameter + 0.1,
            };
        }
    }

    return null;
}

export function applyTrunkReplacement(plan: TrunkReplacementPlan, historyBefore?: SupportState): boolean {
    const snapshot = getSnapshot();
    const before = structuredClone(historyBefore ?? snapshot);
    const trunk = snapshot.trunks[plan.trunkToRemoveId];
    if (!trunk) return false;

    const root = snapshot.roots[trunk.rootId];
    if (!root) return false;

    const candidateBranch = snapshot.branches[plan.candidate.branchId];
    const candidateCone = candidateBranch?.contactCone;
    if (!candidateBranch || !candidateCone) return false;

    const promotedBaselineDiameterMm = Math.max(0.001, ...candidateBranch.segments.map((s) => s.diameter ?? 0));

    const providedTrunk = plan.trunkToAdd;
    const providedRoot = plan.rootToAdd;

    let nextTrunk: Trunk;
    let nextRoot: Roots;

    if (providedTrunk && providedRoot) {
        nextTrunk = providedTrunk;
        nextRoot = providedRoot;
    } else {
        const tipPos = candidateCone.pos;
        const tipNormal = candidateCone.surfaceNormal ?? candidateCone.normal;

        const trunkBuild = buildTrunkData({ tipPos, tipNormal, modelId: candidateBranch.modelId });
        if (trunkBuild.error) return false;

        nextTrunk = trunkBuild.trunk;
        nextRoot = trunkBuild.root;
    }

    // Preserve the promoted candidate branch's contact cone profile on the new trunk.
    // The trunk builder uses current settings; we want the rebuilt trunk to retain the original tip shape.
    if (nextTrunk.contactCone) {
        nextTrunk = {
            ...nextTrunk,
            contactCone: {
                ...nextTrunk.contactCone,
                profile: candidateCone.profile,
                normal: candidateCone.normal,
                surfaceNormal: candidateCone.surfaceNormal,
                diskLengthOverride: candidateCone.diskLengthOverride,
            },
        };
    }

    // After swapping cone profile, the socket joint position may change.
    // Update the trunk socket joint so the shaft remains correctly linked to the cone.
    if (nextTrunk.contactCone?.socketJointId) {
        const socketJointId = nextTrunk.contactCone.socketJointId;
        const socketPos = getFinalSocketPosition(nextTrunk.contactCone);

        const nextSegments = nextTrunk.segments.map((seg) => {
            const nextTopJoint = seg.topJoint && seg.topJoint.id === socketJointId
                ? { ...seg.topJoint, pos: socketPos }
                : seg.topJoint;

            const nextBottomJoint = seg.bottomJoint && seg.bottomJoint.id === socketJointId
                ? { ...seg.bottomJoint, pos: socketPos }
                : seg.bottomJoint;

            return nextTopJoint === seg.topJoint && nextBottomJoint === seg.bottomJoint
                ? seg
                : { ...seg, topJoint: nextTopJoint, bottomJoint: nextBottomJoint };
        });

        nextTrunk = { ...nextTrunk, segments: nextSegments };
    }

    // Ensure promoted trunks carry a stable baseline diameter independent of the active preset.
    nextTrunk = { ...nextTrunk, baseDiameterMm: promotedBaselineDiameterMm };

    const alignedBase = shiftTrunkToRootXY(nextTrunk, nextRoot, root.transform.pos.x, root.transform.pos.y);

    const aligned = {
        root: alignedBase.root,
        trunk: alignedBase.trunk,
    };

    addRoot(aligned.root);
    addTrunk(aligned.trunk);

    const settings = getSettingsSnapshot();
    const attachStepMm = settings.grid?.attachSearchStepMm ?? 2.0;
    // Enforce at least 20° from vertical -> 70° from horizontal.
    const minAngleDeg = Math.max(70, settings.grid?.minBranchAngleDeg ?? 45);

    // Preserve the old trunk contact as a branch attached to the new trunk.
    // NOTE: When the user is explicitly deleting the trunk, we do NOT preserve the old trunk's contact.
    if (plan.meta.mode !== 'delete_trunk_promote_next_highest' && trunk.contactCone) {
        const oldTipPos = trunk.contactCone.pos;
        const oldTipNormal = trunk.contactCone.surfaceNormal ?? trunk.contactCone.normal;
        const oldTrunkContactKnot = createAttachmentKnotOnTrunk({
            trunk: aligned.trunk,
            root: aligned.root,
            referencePos: oldTipPos,
            tipPos: oldTipPos,
            minAngleDeg,
            attachStepMm,
        });
        if (oldTrunkContactKnot) {
            const built = buildBranchData({
                tipPos: oldTipPos,
                tipNormal: oldTipNormal,
                modelId: trunk.modelId,
                parentKnot: oldTrunkContactKnot,
            });

            const preservedDiameterMm = Math.max(0.001, ...trunk.segments.map((s) => s.diameter ?? 0));
            const preserved = applyDiameterToBranch(built.branch, preservedDiameterMm);
            const preservedWithCone = trunk.contactCone
                ? {
                    ...preserved,
                    contactCone: preserved.contactCone
                        ? {
                            ...preserved.contactCone,
                            profile: trunk.contactCone.profile,
                            normal: trunk.contactCone.normal,
                            surfaceNormal: trunk.contactCone.surfaceNormal,
                            diskLengthOverride: trunk.contactCone.diskLengthOverride,
                        }
                        : preserved.contactCone,
                }
                : preserved;

            const preservedWithConeAndSocket = applySocketAndMidJointPositionsForBranch({
                branch: preservedWithCone,
                parentKnotPos: oldTrunkContactKnot.pos,
            });

            addKnot(oldTrunkContactKnot);
            addBranch(preservedWithConeAndSocket);
        }
    }

    // Rehost all connected branches (except the promoted candidate) by updating parent knot.
    // This prevents cascading deletion when we later remove the old trunk and the promoted branch.
    for (const branchId of plan.connectedBranchIds) {
        if (branchId === plan.candidate.branchId) continue;

        const existingBranch = before.branches[branchId];
        if (!existingBranch) continue;
        const oldParentKnot = before.knots[existingBranch.parentKnotId];
        if (!oldParentKnot) continue;

        const newParentKnot = createAttachmentKnotOnTrunk({
            trunk: aligned.trunk,
            root: aligned.root,
            referencePos: oldParentKnot.pos,
            tipPos: existingBranch.contactCone?.pos ?? oldParentKnot.pos,
            minAngleDeg,
            attachStepMm,
        });
        if (!newParentKnot) continue;

        addKnot(newParentKnot);
        const updated = adjustBranchForNewParentKnot(existingBranch, newParentKnot);
        updateBranch(updated);
    }

    // Rehost all connected leaves by recreating the leaf + its parent knot (no leaf update function).
    for (const leafId of plan.connectedLeafIds) {
        const existingLeaf = before.leaves[leafId];
        if (!existingLeaf) continue;
        const oldParentKnot = before.knots[existingLeaf.parentKnotId];
        if (!oldParentKnot) continue;

        // Remove old leaf first (also removes its knot if present).
        removeLeaf(existingLeaf.id);

        const newParentKnot = createAttachmentKnotOnTrunk({
            trunk: aligned.trunk,
            root: aligned.root,
            referencePos: oldParentKnot.pos,
            tipPos: existingLeaf.contactCone.pos,
            minAngleDeg,
            attachStepMm,
        });
        if (!newParentKnot) continue;

        const cone = existingLeaf.contactCone;
        const hostDiameterMm = Math.max(0.001, (newParentKnot.diameter ?? 1.2) - 0.1);

        const built = buildLeafData({
            tipPos: cone.pos,
            surfaceNormal: cone.surfaceNormal ?? cone.normal,
            modelId: existingLeaf.modelId,
            parentKnot: newParentKnot,
            hostDiameterMm,
        });

        addKnot(newParentKnot);
        addLeaf({ ...built.leaf, id: existingLeaf.id });
    }

    // Remove the promoted branch (it becomes the new trunk).
    removeBranch(plan.candidate.branchId);

    // Now it's safe to remove the old trunk without cascading away the rehosted trees.
    removeTrunk(plan.trunkToRemoveId);

    // Apply stepwise trunk diameter profile on the resulting trunk based on its attached branches.
    const snapshotWithAttachments = getSnapshot();
    const applied = computeAndApplyTrunkDiameterProfile(snapshotWithAttachments, aligned.trunk.id, {
        baseShaftDiameterMm: promotedBaselineDiameterMm,
    });
    if (applied) {
        for (const u of applied.knotUpdates) {
            updateKnot(u.after);
        }
        updateTrunk(applied.trunk);
    }

    const after = structuredClone(getSnapshot());

    const payload: SupportReplaceTrunkPayload = {
        before,
        after,
    };

    pushHistory({ type: SUPPORT_REPLACE_TRUNK, payload });

    return true;
}

import { useCallback, useState, useEffect } from 'react';
import * as THREE from 'three';
import { addBranch, addKnot, addRoot, addTrunk, getSnapshot, setSnapshot, updateKnot, updateTrunk } from '../../state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_ADD_BRANCH, SUPPORT_ADD_TRUNK } from '../../history/actionTypes';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { buildTrunkData } from './trunkBuilder';
import { applyTrunkReplacement, computeAndApplyTrunkDiameterProfile, planTrunkReplacement } from './TrunkReplacement';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { LimitationCode, WarningCode } from '../../types';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { getSettings } from '../../Settings';
import { decideGridPlacement } from '../../PlacementLogic/Grid';

export function useTrunkPlacementV2() {
    const [previewData, setPreviewData] = useState<SupportData | null>(null);
    const [previewError, setPreviewError] = useState<LimitationCode | null>(null);
    const [previewWarning, setPreviewWarning] = useState<WarningCode | null>(null);
    const { isPlacementDisabled } = useInteractionStatus();

    // Auto-clear preview when placement is disabled (e.g. hovering another object)
    useEffect(() => {
        if (isPlacementDisabled) {
            setPreviewData(null);
            setPreviewError(null);
            setPreviewWarning(null);
        }
    }, [isPlacementDisabled]);

    const onSupportHover = useCallback((hit: THREE.Intersection | null) => {
        if (isPlacementDisabled) {
            setPreviewData(null);
            setPreviewError(null);
            setPreviewWarning(null);
            return;
        }

        if (!hit) {
            setPreviewData(null);
            setPreviewError(null);
            setPreviewWarning(null);
            return;
        }
        
        // Calculate Smoothed Normal
        const tipNormal = calculateSmoothedNormal(hit);
        const tipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData.modelId || 'unknown';
        
        // Pass mesh for collision detection
        const mesh = hit.object instanceof THREE.Mesh ? hit.object : undefined;
        const result = buildTrunkData({ tipPos, tipNormal, modelId, mesh });
        const decision = decideGridPlacement({
            settings: getSettings(),
            snapshot: getSnapshot(),
            candidate: result,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });

        if (decision.kind === 'place_trunk') {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(decision.trunkBuild.error || null);
            setPreviewWarning(decision.trunkBuild.warning || null);
            return;
        }

        if (decision.kind === 'replace_trunk') {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(decision.trunkBuild.error || null);
            setPreviewWarning(decision.trunkBuild.warning || null);
            return;
        }

        if (decision.kind === 'place_branch') {
            setPreviewData(decision.supportData);
            setPreviewError(null);
            setPreviewWarning(null);
            return;
        }

        // reject
        setPreviewData(null);
        setPreviewError(
            decision.reason === 'KNOT_ABOVE_TIP'
                ? 'KNOT_ABOVE_TIP'
                : decision.reason === 'COLLISION_WITH_MODEL'
                    ? 'COLLISION_WITH_MODEL'
                    : null
        );
        setPreviewWarning(null);
    }, [isPlacementDisabled]);

    const onSupportClick = useCallback((hit: THREE.Intersection) => {
        if (isPlacementDisabled || !hit) return;

        // Re-calculate smoothed normal for click
        const tipNormal = calculateSmoothedNormal(hit);
        const tipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData.modelId || 'unknown';
        
        // Pass mesh for collision detection
        const mesh = hit.object instanceof THREE.Mesh ? hit.object : undefined;
        const result = buildTrunkData({ tipPos, tipNormal, modelId, mesh });

        // If invalid placement (ERROR), ignore click.
        // If it's just a WARNING, allow placement.
        if (result.error) return;

        const decision = decideGridPlacement({
            settings: getSettings(),
            snapshot: getSnapshot(),
            candidate: result,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });

        if (decision.kind === 'place_branch') {
            addKnot(decision.knot);
            addBranch(decision.branch);

            const snapshotAfterAdd = getSnapshot();
            const hostTrunk = snapshotAfterAdd.trunks[decision.hostTrunkId];
            const trunkUpdate = hostTrunk
                ? (() => {
                    const applied = computeAndApplyTrunkDiameterProfile(snapshotAfterAdd, decision.hostTrunkId);
                    if (!applied) return null;

                    for (const u of applied.knotUpdates) {
                        updateKnot(u.after);
                    }

                    updateTrunk(applied.trunk);
                    return { before: hostTrunk, after: applied.trunk, knotUpdates: applied.knotUpdates };
                })()
                : null;

            pushHistory({
                type: SUPPORT_ADD_BRANCH,
                payload: {
                    branch: decision.branch,
                    knot: decision.knot,
                    trunkUpdate: trunkUpdate ? { before: trunkUpdate.before, after: trunkUpdate.after } : undefined,
                    knotUpdates: trunkUpdate?.knotUpdates ?? undefined,
                },
            });
            return;
        }

        if (decision.kind === 'replace_trunk') {
            const before = structuredClone(getSnapshot());

            // Materialize the promoted branch (and its knot) into state so the planner can reference it.
            addKnot(decision.promoteKnot);
            addBranch(decision.promoteBranch);

            const planned = planTrunkReplacement({
                snapshot: getSnapshot(),
                trunkIdToRemove: decision.hostTrunkId,
                mode: 'grid_promote_candidate_to_trunk',
                nodeKey: decision.nodeKey,
                promoteBranchId: decision.promoteBranch.id,
            });

            const plan = planned?.plan;
            if (!plan) {
                setSnapshot(before);
                return;
            }

            const planWithBuild = {
                ...plan,
                trunkToAdd: decision.trunkBuild.trunk,
                rootToAdd: decision.trunkBuild.root,
            };

            const ok = applyTrunkReplacement(planWithBuild, before);
            if (!ok) {
                setSnapshot(before);
            }

            return;
        }

        if (decision.kind === 'reject') {
            return;
        }

        // decision.kind === 'place_trunk'
        const trunkBuild = decision.trunkBuild;
        
        // Add to store
        addRoot(trunkBuild.root);
        addTrunk(trunkBuild.trunk);
        pushHistory({
            type: SUPPORT_ADD_TRUNK,
            payload: {
                trunk: trunkBuild.trunk,
                root: trunkBuild.root,
            },
        });
        
        console.log('[V2] Added trunk:', trunkBuild.trunk.id, 'to model:', modelId);
    }, [isPlacementDisabled]);

    return {
        onSupportHover,
        onSupportClick,
        previewData,
        previewError,
        previewWarning
    };
}

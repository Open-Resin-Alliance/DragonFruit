import { useCallback, useState, useEffect, useRef } from 'react';
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
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { isContactDiskHudInteractionActive } from '../../SupportPrimitives/ContactDisk/contactDiskHudInteraction';

export function useTrunkPlacementV2() {
    const HOVER_MIN_INTERVAL_MS = 9;
    const HOVER_POS_EPSILON_MM = 0.06;
    const HOVER_NORMAL_DOT_MIN = 0.999;

    const [previewData, setPreviewData] = useState<SupportData | null>(null);
    const [previewError, setPreviewError] = useState<LimitationCode | null>(null);
    const [previewWarning, setPreviewWarning] = useState<WarningCode | null>(null);
    const { isPlacementHardDisabled } = useInteractionStatus();
    const hoverFrameRef = useRef<number | null>(null);
    const latestHoverRef = useRef<THREE.Intersection | null>(null);
    const normalMatrixRef = useRef(new THREE.Matrix3());
    const hoverNormalRef = useRef(new THREE.Vector3());
    const hoverFaceNormalRef = useRef(new THREE.Vector3());
    const lastProcessedHoverRef = useRef<{
        objectUuid: string;
        modelId: string;
        point: THREE.Vector3;
        normal: THREE.Vector3;
        atMs: number;
    } | null>(null);

    const clearPreview = useCallback(() => {
        setPreviewData((prev) => (prev === null ? prev : null));
        setPreviewError((prev) => (prev === null ? prev : null));
        setPreviewWarning((prev) => (prev === null ? prev : null));
    }, []);

    // Auto-clear preview when placement is disabled (e.g. hovering another object)
    useEffect(() => {
        if (isPlacementHardDisabled) {
            clearPreview();
        }
    }, [clearPreview, isPlacementHardDisabled]);

    useEffect(() => {
        return () => {
            if (hoverFrameRef.current !== null) {
                cancelAnimationFrame(hoverFrameRef.current);
                hoverFrameRef.current = null;
            }
        };
    }, []);

    const processSupportHover = useCallback((hit: THREE.Intersection | null) => {
        if (isContactDiskHudInteractionActive()) {
            clearPreview();
            lastProcessedHoverRef.current = null;
            return;
        }

        if (isPlacementHardDisabled) {
            clearPreview();
            lastProcessedHoverRef.current = null;
            return;
        }

        if (!hit) {
            clearPreview();
            lastProcessedHoverRef.current = null;
            return;
        }

        const modelId = hit.object.userData.modelId || 'unknown';
        const objectUuid = hit.object.uuid;

        // Fast hover normal for responsive preview: use transformed face normal.
        // (Click path still uses smoothed normal for final placement correctness.)
        let tipNormal: { x: number; y: number; z: number };
        if (hit.face) {
            hoverFaceNormalRef.current.copy(hit.face.normal);
            if (hit.object instanceof THREE.Mesh) {
                normalMatrixRef.current.getNormalMatrix(hit.object.matrixWorld);
                hoverFaceNormalRef.current.applyNormalMatrix(normalMatrixRef.current);
            }
            hoverFaceNormalRef.current.normalize();
            tipNormal = {
                x: hoverFaceNormalRef.current.x,
                y: hoverFaceNormalRef.current.y,
                z: hoverFaceNormalRef.current.z,
            };
        } else {
            tipNormal = calculateSmoothedNormal(hit);
        }

        const now = performance.now();
        hoverNormalRef.current.set(tipNormal.x, tipNormal.y, tipNormal.z);
        const prev = lastProcessedHoverRef.current;
        if (prev && prev.objectUuid === objectUuid && prev.modelId === modelId) {
            const dt = now - prev.atMs;
            const posDeltaSq = prev.point.distanceToSquared(hit.point);
            const normalDot = prev.normal.dot(hoverNormalRef.current);
            const posEpsSq = HOVER_POS_EPSILON_MM * HOVER_POS_EPSILON_MM;

            if (dt < HOVER_MIN_INTERVAL_MS && posDeltaSq <= posEpsSq && normalDot >= HOVER_NORMAL_DOT_MIN) {
                return;
            }
        }

        if (prev) {
            prev.objectUuid = objectUuid;
            prev.modelId = modelId;
            prev.point.copy(hit.point);
            prev.normal.copy(hoverNormalRef.current);
            prev.atMs = now;
        } else {
            lastProcessedHoverRef.current = {
                objectUuid,
                modelId,
                point: hit.point.clone(),
                normal: hoverNormalRef.current.clone(),
                atMs: now,
            };
        }

        const tipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };

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
        if (decision.trunkBuild) {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(decision.trunkBuild.error || null);
            setPreviewWarning(decision.trunkBuild.warning || null);
            return;
        }

        setPreviewData((prev) => (prev === null ? prev : null));
        setPreviewError(
            decision.reason === 'KNOT_ABOVE_TIP'
                ? 'KNOT_ABOVE_TIP'
                : decision.reason === 'COLLISION_WITH_MODEL'
                    ? 'COLLISION_WITH_MODEL'
                    : null
        );
        setPreviewWarning((prev) => (prev === null ? prev : null));
    }, [HOVER_MIN_INTERVAL_MS, HOVER_NORMAL_DOT_MIN, HOVER_POS_EPSILON_MM, clearPreview, isPlacementHardDisabled]);

    const onSupportHover = useCallback((hit: THREE.Intersection | null) => {
        latestHoverRef.current = hit;

        if (hoverFrameRef.current !== null) return;

        hoverFrameRef.current = requestAnimationFrame(() => {
            hoverFrameRef.current = null;
            processSupportHover(latestHoverRef.current);
        });
    }, [processSupportHover]);

    const onSupportClick = useCallback((hit: THREE.Intersection) => {
        if (isPlacementHardDisabled || !hit) return;

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
            clearSupportSelection();
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
            } else {
                clearSupportSelection();
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
        
        clearSupportSelection();
        console.log('[V2] Added trunk:', trunkBuild.trunk.id, 'to model:', modelId);
    }, [isPlacementHardDisabled]);

    return {
        onSupportHover,
        onSupportClick,
        previewData,
        previewError,
        previewWarning
    };
}

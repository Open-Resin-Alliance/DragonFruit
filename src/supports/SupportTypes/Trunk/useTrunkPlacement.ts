import { useCallback, useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { addAnchor, addBranch, addKnot, addLeaf, addRoot, addStick, addTrunk, addTwig, getSnapshot, setSnapshot, updateKnot, updateTrunk } from '../../state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_ADD_ANCHOR, SUPPORT_ADD_BRANCH, SUPPORT_ADD_LEAF, SUPPORT_ADD_STICK, SUPPORT_ADD_TRUNK, SUPPORT_ADD_TWIG } from '../../history/actionTypes';
import { useInteractionStatus } from '../../interaction/useInteractionStatus';
import { buildTrunkData } from './trunkBuilder';
import { applyTrunkReplacement, computeAndApplyTrunkDiameterProfile, planTrunkReplacement } from './TrunkReplacement';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { LimitationCode, WarningCode } from '../../types';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { getSettings } from '../../Settings';
import { decideGridPlacement } from '../../PlacementLogic/Grid';
import { clearSupportSelection } from '../../interaction/shared/selection/selectionController';
import { isContactDiskHudInteractionActive, shouldSuppressContactDiskHudPlacementCommit } from '../../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { buildStick } from '../Stick/stickBuilder';
import { buildTwig } from '../Twig/twigBuilder';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { getSupportPathfindingDebugEnabled, setSupportPathfindingDebugSnapshot } from '../../PlacementLogic/Pathfinding/pathfindingDebugState';

// ---------------------------------------------------------------------------
// Cavity stick helpers
// ---------------------------------------------------------------------------

const _cavityRaycaster = new THREE.Raycaster();
const _downDir = new THREE.Vector3(0, 0, -1);
const CAVITY_PREVIEW_CACHE_POS_EPSILON_MM = 1.0;
const CAVITY_PREVIEW_CACHE_NORMAL_DOT_MIN = 0.99;
const CAVITY_PREVIEW_CACHE_MISS_MAX_AGE_MS = 220;

/**
 * When A* stagnates (tip is inside a closed cavity), attempt to find the
 * cavity floor by raycasting straight down.  Returns a buildStick result +
 * a SupportData preview object, or null if no lower surface is found.
 */
function buildCavityStick(
    tipPos: { x: number; y: number; z: number },
    tipNormal: { x: number; y: number; z: number },
    modelId: string,
    mesh: THREE.Mesh,
): (
    | { kind: 'stick'; supportData: SupportData; stick: ReturnType<typeof buildStick>['stick'] }
    | { kind: 'twig'; supportData: SupportData; twig: ReturnType<typeof buildTwig>['twig'] }
) | null {
    _cavityRaycaster.set(
        new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z),
        _downDir,
    );
    // Offset origin slightly inward along tip normal so we don't self-hit the
    // surface we just clicked.
    const OFFSET_MM = 0.5;
    _cavityRaycaster.ray.origin.addScaledVector(
        new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z),
        OFFSET_MM,
    );
    _cavityRaycaster.ray.origin.z -= OFFSET_MM * 0.1; // nudge down past origin surface

    const hits = _cavityRaycaster.intersectObject(mesh, false);
    if (hits.length === 0) return null;

    // Prefer a true "floor" hit (normal has meaningful +Z) so the bottom
    // endpoint clings vertically down when possible. Only fall back to any
    // below-tip hit (e.g. sidewall) if no floor-like surface is found.
    const BELOW_EPS_MM = 0.1;
    const FLOOR_Z_MIN = 0.35;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    type Candidate = { hit: THREE.Intersection; normal: THREE.Vector3 };
    const MAX_HIT_SCAN = 64;
    let scanned = 0;
    let firstBelowCandidate: Candidate | null = null;
    let floorCandidate: Candidate | null = null;

    for (const h of hits) {
        scanned += 1;
        if (scanned > MAX_HIT_SCAN) break;
        if (h.point.z >= tipPos.z - BELOW_EPS_MM) continue;
        if (!h.face) continue;
        const n = h.face.normal.clone().applyNormalMatrix(normalMatrix).normalize();
        const candidate = { hit: h, normal: n };
        if (!firstBelowCandidate) firstBelowCandidate = candidate;
        if (n.z >= FLOOR_Z_MIN) {
            floorCandidate = candidate;
            break;
        }
    }

    const chosen = floorCandidate ?? firstBelowCandidate;
    if (!chosen) return null;

    const bPos = { x: chosen.hit.point.x, y: chosen.hit.point.y, z: chosen.hit.point.z };
    const bNormal = { x: chosen.normal.x, y: chosen.normal.y, z: chosen.normal.z };

    const settings = getSettings();
    const cutoff = settings.meshToMesh?.stickVsTwigCutoffMm ?? 5;
    const dx = tipPos.x - bPos.x;
    const dy = tipPos.y - bPos.y;
    const dz = tipPos.z - bPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const kind: 'twig' | 'stick' = dist > cutoff ? 'stick' : 'twig';

    if (kind === 'twig') {
        const { twig } = buildTwig({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });
        const supportData: SupportData = {
            id: twig.id,
            segments: twig.segments,
            contactDisks: [twig.contactDiskA, twig.contactDiskB],
        };
        return { kind, twig, supportData };
    }

    const { stick } = buildStick({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });

    const supportData: SupportData = {
        id: stick.id,
        segments: stick.segments,
        contactCones: [stick.contactConeA, stick.contactConeB],
    };

    return { kind: 'stick', stick, supportData };
}

type CavityStickBuildResult = NonNullable<ReturnType<typeof buildCavityStick>>;

export function useTrunkPlacementV2() {
    const HOVER_MIN_INTERVAL_MS = 9;
    const HOVER_POS_EPSILON_MM = 0.1;
    const HOVER_NORMAL_DOT_MIN = 0.998;
    const { getHotkey } = useHotkeyConfig();
    const forcePlaceBinding = getHotkey('SUPPORTS', 'FORCE_PLACE_SUPPORT');

    const [previewData, setPreviewData] = useState<SupportData | null>(null);
    const [previewError, setPreviewError] = useState<LimitationCode | null>(null);
    const [previewWarning, setPreviewWarning] = useState<WarningCode | null>(null);
    const { isPlacementHardDisabled } = useInteractionStatus();
    const hoverFrameRef = useRef<number | null>(null);
    const latestHoverRef = useRef<THREE.Intersection | null>(null);
    const forcePlaceOverrideRef = useRef(false);
    const hoverNormalRef = useRef(new THREE.Vector3());
    const cavityPreviewCacheNormalRef = useRef(new THREE.Vector3());
    const cavityPreviewCacheRef = useRef<{
        objectUuid: string;
        modelId: string;
        point: THREE.Vector3;
        normal: THREE.Vector3;
        atMs: number;
        result: CavityStickBuildResult | null;
    } | null>(null);
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
        cavityPreviewCacheRef.current = null;
        if (getSupportPathfindingDebugEnabled()) {
            setSupportPathfindingDebugSnapshot(null);
        }
    }, []);

    const commitTrunkBuild = useCallback((trunkBuild: ReturnType<typeof buildTrunkData>) => {
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
    }, []);

    const resolveCavityStickPreview = useCallback((
        hit: THREE.Intersection,
        tipPos: { x: number; y: number; z: number },
        tipNormal: { x: number; y: number; z: number },
        modelId: string,
        mesh: THREE.Mesh,
    ): CavityStickBuildResult | null => {
        const now = performance.now();
        const cached = cavityPreviewCacheRef.current;
        if (cached && cached.objectUuid === hit.object.uuid && cached.modelId === modelId && cached.result === null) {
            if ((now - cached.atMs) <= CAVITY_PREVIEW_CACHE_MISS_MAX_AGE_MS) {
                const posEpsSq = CAVITY_PREVIEW_CACHE_POS_EPSILON_MM * CAVITY_PREVIEW_CACHE_POS_EPSILON_MM;
                if (cached.point.distanceToSquared(hit.point) <= posEpsSq) {
                    cavityPreviewCacheNormalRef.current.set(tipNormal.x, tipNormal.y, tipNormal.z);
                    if (cached.normal.dot(cavityPreviewCacheNormalRef.current) >= CAVITY_PREVIEW_CACHE_NORMAL_DOT_MIN) {
                        return cached.result;
                    }
                }
            }
        }

        const computed = buildCavityStick(tipPos, tipNormal, modelId, mesh);

        // Cache only misses; successful stick previews should track pointer motion
        // continuously and must not reuse stale geometry.
        if (!computed) {
            cavityPreviewCacheRef.current = {
                objectUuid: hit.object.uuid,
                modelId,
                point: hit.point.clone(),
                normal: new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z),
                atMs: now,
                result: null,
            };
        } else {
            cavityPreviewCacheRef.current = null;
        }

        return computed;
    }, []);

    // Auto-clear preview when placement is disabled (e.g. hovering another object)
    useEffect(() => {
        if (isPlacementHardDisabled) {
            const frame = requestAnimationFrame(() => {
                clearPreview();
            });
            return () => cancelAnimationFrame(frame);
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

        // Keep hover preview on the same normal basis as click placement to
        // avoid preview-only false collision reports near tolerance boundaries.
        const tipNormal = calculateSmoothedNormal(hit);

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
        const result = buildTrunkData({ tipPos, tipNormal, modelId, mesh, isPreview: true });
        const settings = getSettings();

        // Fast-path for cavity hover when stagnated (closed cavity) or budget
        // exhausted after both V1+V2 failed — these are genuine routing dead-ends.
        if (result.stagnated || result.exhaustedBudget) {
            if (mesh) {
                const cavityStick = resolveCavityStickPreview(hit, tipPos, tipNormal, modelId, mesh);
                if (cavityStick) {
                    setPreviewData(cavityStick.supportData);
                    setPreviewError(null);
                    setPreviewWarning(null);
                    return;
                }
            }
            setPreviewData(result.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (result.error || null));
            setPreviewWarning(null);
            return;
        }

        const decision = decideGridPlacement({
            settings,
            snapshot: getSnapshot(),
            candidate: result,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });

        if (decision.kind === 'place_trunk') {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (decision.trunkBuild.error || null));
            setPreviewWarning(decision.trunkBuild.warning || null);
            return;
        }

        if (decision.kind === 'replace_trunk') {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (decision.trunkBuild.error || null));
            setPreviewWarning(decision.trunkBuild.warning || null);
            return;
        }

        if (decision.kind === 'place_branch') {
            setPreviewData(decision.supportData);
            setPreviewError(null);
            setPreviewWarning(null);
            return;
        }

        if (decision.kind === 'place_leaf') {
            setPreviewData(decision.supportData);
            setPreviewError(null);
            setPreviewWarning(null);
            return;
        }

        if (decision.kind === 'place_anchor') {
            setPreviewData(decision.supportData);
            setPreviewError(null);
            setPreviewWarning(null);
            return;
        }

        // reject
        if (decision.trunkBuild) {
            setPreviewData(decision.trunkBuild.supportData);
            setPreviewError(forcePlaceOverrideRef.current ? null : (decision.trunkBuild.error || null));
            setPreviewWarning(decision.trunkBuild.warning || null);
            return;
        }

        setPreviewData((prev) => (prev === null ? prev : null));
        setPreviewError(forcePlaceOverrideRef.current
            ? null
            : decision.reason === 'KNOT_ABOVE_TIP'
                ? 'KNOT_ABOVE_TIP'
                : decision.reason === 'COLLISION_WITH_MODEL'
                    ? 'COLLISION_WITH_MODEL'
                    : null
        );
        setPreviewWarning((prev) => (prev === null ? prev : null));
    }, [HOVER_MIN_INTERVAL_MS, HOVER_NORMAL_DOT_MIN, HOVER_POS_EPSILON_MM, clearPreview, isPlacementHardDisabled, resolveCavityStickPreview]);

    useEffect(() => {
        const refreshCurrentHover = () => {
            if (hoverFrameRef.current !== null) return;
            hoverFrameRef.current = requestAnimationFrame(() => {
                hoverFrameRef.current = null;
                processSupportHover(latestHoverRef.current);
            });
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!matchesConfiguredHotkeyDown(event, forcePlaceBinding) || forcePlaceOverrideRef.current) return;
            event.preventDefault();
            forcePlaceOverrideRef.current = true;
            refreshCurrentHover();
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (!matchesConfiguredHotkeyUp(event, forcePlaceBinding) || !forcePlaceOverrideRef.current) return;
            event.preventDefault();
            forcePlaceOverrideRef.current = false;
            refreshCurrentHover();
        };

        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('keyup', handleKeyUp, true);
        document.addEventListener('keyup', handleKeyUp, true);
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('keyup', handleKeyUp, true);
            document.removeEventListener('keyup', handleKeyUp, true);
        };
    }, [forcePlaceBinding, processSupportHover]);

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
        // Suppress placement if a contact-disk HUD drag just ended; the
        // mouseup that ends the drag would otherwise propagate to the canvas
        // and be interpreted as a trunk placement click.
        if (shouldSuppressContactDiskHudPlacementCommit()) return;

        // Re-calculate smoothed normal for click
        const tipNormal = calculateSmoothedNormal(hit);
        const tipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        const modelId = hit.object.userData.modelId || 'unknown';
        
        // Pass mesh for collision detection
        const mesh = hit.object instanceof THREE.Mesh ? hit.object : undefined;
        const result = buildTrunkData({ tipPos, tipNormal, modelId, mesh });

        // When the pathfinder stagnates or exhausts both V1+V2 budgets, the tip
        // can't route to the build plate. Fall back to a cavity stick/twig that
        // spans straight down to the nearest suitable surface.
        if (result.stagnated || result.exhaustedBudget) {
            if (mesh) {
                const cavityStick = buildCavityStick(tipPos, tipNormal, modelId, mesh);
                if (cavityStick) {
                    if (cavityStick.kind === 'twig') {
                        addTwig(cavityStick.twig);
                        pushHistory({
                            type: SUPPORT_ADD_TWIG,
                            payload: { twig: cavityStick.twig },
                        });
                    } else {
                        addStick(cavityStick.stick);
                        pushHistory({
                            type: SUPPORT_ADD_STICK,
                            payload: { stick: cavityStick.stick },
                        });
                    }
                    clearSupportSelection();
                    return;
                }
            }
            // No cavity floor found — bail silently; hover preview already shows the error.
            if (forcePlaceOverrideRef.current) {
                commitTrunkBuild(result);
            }
            return;
        }

        // In grid mode, decideGridPlacement may override a trunk error into a place_branch decision.
        // Only bail on trunk errors when grid is disabled (direct placement path).
        const settings = getSettings();
        if (result.error && !settings.grid?.enabled) {
            if (forcePlaceOverrideRef.current) {
                commitTrunkBuild(result);
            }
            // Stick/twig is now strict last resort: do not fallback here unless
            // the solver reported true stagnation (handled above).
            return;
        }

        const decision = decideGridPlacement({
            settings,
            snapshot: getSnapshot(),
            candidate: result,
            tipPos,
            tipNormal,
            modelId,
            mesh,
        });

        if (decision.kind === 'place_anchor') {
            addAnchor(decision.anchor);
            pushHistory({
                type: SUPPORT_ADD_ANCHOR,
                payload: { anchor: decision.anchor },
            });
            clearSupportSelection();
            return;
        }

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

        if (decision.kind === 'place_leaf') {
            addKnot(decision.knot);
            addLeaf(decision.leaf);

            pushHistory({
                type: SUPPORT_ADD_LEAF,
                payload: {
                    leaf: decision.leaf,
                    knot: decision.knot,
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
            if (forcePlaceOverrideRef.current && decision.trunkBuild) {
                commitTrunkBuild(decision.trunkBuild);
            }
            // Stick/twig is now strict last resort: keep reject behavior here.
            return;
        }

        // decision.kind === 'place_trunk'
        const trunkBuild = decision.trunkBuild;
        
        commitTrunkBuild(trunkBuild);
        console.log('[V2] Added trunk:', trunkBuild.trunk.id, 'to model:', modelId);
    }, [commitTrunkBuild, isPlacementHardDisabled]);

    return {
        onSupportHover,
        onSupportClick,
        previewData,
        previewError,
        previewWarning
    };
}

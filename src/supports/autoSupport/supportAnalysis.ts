import * as THREE from 'three';
import { geometryCentroidMm } from '@/features/printing/modelResinVolume';
import { getRaftSettingsForModel } from '../Rafts/Crenelated/RaftState';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import type { SupportState } from '../types';
import type { AutoPlaceWorkerPayload } from './autoPlace.worker.shared';
import { getCachedRepresentativeLayers } from './frameStressState';
import { supportBreakStrengthMpa, DEFAULT_RESIN_TENSILE_STRENGTH_MPA } from './greenMaterialCalibration';
import { evaluatePrintability, type PrintabilityReport } from './printability';
import { measurePoseStability, posedPositions } from './poseStability';
import { buildSupportGraph, solveSupportFrameStress, type SupportFrameStressReport } from './supportGraphStress';
import { evaluateToppleRisk, toppleRiskNeedsCoverage, type ToppleRiskReport } from './toppleRisk';
import { FLOATING_Z_THRESHOLD_MM } from './supportStressReport';

export interface SupportAnalysisProgress {
    phase: string;
    done: number;
    total: number;
}

export interface SupportAnalysisResult {
    frame: SupportFrameStressReport;
    printability: PrintabilityReport;
    topple: ToppleRiskReport | null;
}

function deserializeIslands(islands: AutoPlaceWorkerPayload['islands']): DetectedIsland[] {
    return islands.map((island) => ({
        ...island,
        contact: new THREE.Vector3(island.contact.x, island.contact.y, island.contact.z),
        ...(island.subApexes
            ? { subApexes: island.subApexes.map((point) => ({ x: point.x, y: point.y, z: point.z })) }
            : {}),
    })) as DetectedIsland[];
}

function hasContact(snapshot: SupportState): boolean {
    return [snapshot.trunks, snapshot.branches, snapshot.leaves,
        snapshot.stumps, snapshot.sticks, snapshot.twigs]
        .some((collection) => Object.keys(collection ?? {}).length > 0);
}

/**
 * The frame/printability/topple pass the support panel used to run on the main
 * thread. It is pure apart from the seeded store/mesh/settings, so the worker
 * and the in-process fallback run the same code.
 */
export function runSupportAnalysis(
    payload: AutoPlaceWorkerPayload,
    mesh: THREE.Mesh | undefined,
    onProgress?: (progress: SupportAnalysisProgress) => void,
): SupportAnalysisResult {
    const layerHeightMm = payload.layerHeightMm;
    const tensileStrengthMpa = payload.tensileStrengthMpa ?? DEFAULT_RESIN_TENSILE_STRENGTH_MPA;

    onProgress?.({ phase: 'Sampling layers', done: 0, total: 1 });
    const profile = mesh ? getCachedRepresentativeLayers(mesh, layerHeightMm) : undefined;
    onProgress?.({ phase: 'Sampling layers', done: 1, total: 1 });

    onProgress?.({ phase: 'Building support graph', done: 0, total: 1 });
    const graph = buildSupportGraph(payload.baseState, payload.modelId);
    onProgress?.({ phase: 'Building support graph', done: 1, total: 1 });

    onProgress?.({ phase: 'Solving frame', done: 0, total: 1 });
    const areaPerSupportMm2 = payload.analysis?.areaPerSupportMm2 ?? 10;
    const frame = solveSupportFrameStress(graph, profile, {
        areaPerSupportMm2,
        supportStrengthMpa: supportBreakStrengthMpa(tensileStrengthMpa),
        memberStrengthMpa: tensileStrengthMpa,
    });
    onProgress?.({ phase: 'Solving frame', done: 1, total: 1 });

    onProgress?.({ phase: 'Stability', done: 0, total: 1 });
    const topple = mesh ? computeLiveToppleRisk(
        payload.modelId,
        mesh,
        profile,
        frame.maxTipRockingMm,
        frame.tipCount > 0 || hasContact(payload.baseState),
    ) : null;
    onProgress?.({ phase: 'Stability', done: 1, total: 1 });

    onProgress?.({ phase: 'Printability', done: 0, total: 1 });
    const printability = evaluatePrintability({
        islands: deserializeIslands(payload.islands),
        snapshot: payload.baseState,
        modelId: payload.modelId,
        areaPerSupportMm2,
        profile,
        poseDragMomentMm3: payload.analysis?.poseDragMomentMm3,
        toppleCoverageNeeded: topple
            ? toppleRiskNeedsCoverage(topple)
            : Boolean(payload.analysis?.toppleCoverageNeeded),
        frame: {
            maxTipUtilizationPct: frame.maxTipUtilizationPct,
            maxMemberUtilizationPct: frame.maxMemberUtilizationPct,
        },
    });
    onProgress?.({ phase: 'Printability', done: 1, total: 1 });

    return { frame, printability, topple };
}

/** The live topple estimate the panel showed: the same mesh/profile inputs,
 *  now available to the worker. */
function computeLiveToppleRisk(
    modelId: string,
    mesh: THREE.Mesh,
    profile: Parameters<typeof evaluateToppleRisk>[0]['profile'],
    rockingMm: number,
    hasSupports: boolean,
): ToppleRiskReport | null {
    if (!mesh.geometry) return null;
    const indexAttr = mesh.geometry.getIndex();
    const hasRaft = getRaftSettingsForModel(modelId).bottomMode !== 'off';
    const poseStability = measurePoseStability(
        posedPositions(mesh),
        indexAttr ? (indexAttr.array as ArrayLike<number>) : null,
        0,
        0,
        undefined,
        hasRaft,
    );
    if (!hasSupports && poseStability.plateZMm > FLOATING_Z_THRESHOLD_MM) {
        return null;
    }
    const edgeNormal = poseStability.worstEdgeNormal;
    if (
        !poseStability.worstEdgePoint
        || !edgeNormal
        || Math.hypot(edgeNormal.x, edgeNormal.y) <= 1e-6
        || poseStability.bearingAreaMm2 <= 0
    ) {
        return null;
    }
    const localCentroid = geometryCentroidMm(mesh.geometry);
    if (!localCentroid) return null;
    mesh.updateMatrixWorld();
    const worldCentroid = new THREE.Vector3(localCentroid.x, localCentroid.y, localCentroid.z)
        .applyMatrix4(mesh.matrixWorld);
    return evaluateToppleRisk({
        profile,
        centroid: { x: worldCentroid.x, y: worldCentroid.y },
        edge: { point: poseStability.worstEdgePoint, normal: edgeNormal },
        bearingAreaMm2: poseStability.bearingAreaMm2,
        contactDepthMm: poseStability.contactDepthMm,
        frameRockingMm: rockingMm,
    });
}

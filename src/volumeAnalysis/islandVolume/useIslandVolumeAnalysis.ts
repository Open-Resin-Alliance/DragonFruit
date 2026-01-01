import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
// import { runStep1Scan } from './steps/Step1_BasicScan'; // Superseded
import { type GeometryWithBounds } from '@/hooks/useStlGeometry';
import { type IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import { runIslandScan, type ScanResults, type ScanParams } from './steps/voxelization/ScanOrchestrator';
import { type BasinFillSimulator } from './steps/expansion/BasinFillSimulator'; // Type only here
import { BasinFillProxy } from './steps/expansion/BasinFillProxy';
import { MeshClassifier, type MeshClassificationResult, type ClassificationOutput } from './steps/Step5_MeshClassification';

export type StepStatus = 'pending' | 'running' | 'complete' | 'verified';

export interface VoxelizationOptions {
    voxelSize: number;
}

export interface IslandVolumeAnalysisState {
    currentStep: number;
    steps: Record<number, StepStatus>;

    // Data State
    islandMarkers: IslandMarker[]; // Step 1
    scanResults: ScanResults | null; // Step 2 (Replces VoxelGrid)
    scanBBox: THREE.Box3 | null;
    classificationResults: ClassificationOutput | null; // Step 5

    // Actions
    runStep1: (options?: VoxelizationOptions) => Promise<void>; // Updated signature
    runStep2: (options?: VoxelizationOptions) => Promise<void>;
    runStep3: () => Promise<void>;
    runStep4: () => Promise<void>;
    runStep5: () => Promise<void>;
    reset: () => void;

    // Visualization State
    showLowestPoints: boolean;
    setShowLowestPoints: (show: boolean) => void;

    showVoxels: boolean;
    setShowVoxels: (show: boolean) => void;

    showCenters: boolean;
    setShowCenters: (show: boolean) => void;

    showSeeds: boolean;
    setShowSeeds: (show: boolean) => void;

    showExpansion: boolean;
    setShowExpansion: (show: boolean) => void;
    expansionSimulator: BasinFillSimulator | BasinFillProxy | null;

    // Parameters
    voxelSize: number;
    setVoxelSize: (size: number) => void;

    // Progress
    progress: { done: number; total: number } | null;
}

export function useIslandVolumeAnalysis(
    geom: GeometryWithBounds | null,
    transform: TransformState | null
) {
    const [currentStep, setCurrentStep] = useState(1);
    const [steps, setSteps] = useState<Record<number, StepStatus>>({
        1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending',
        5: 'pending', 6: 'pending', 7: 'pending', 8: 'pending'
    });

    // Data
    const [islandMarkers, setIslandMarkers] = useState<IslandMarker[]>([]);
    const [scanResults, setScanResults] = useState<ScanResults | null>(null);
    const [scanBBox, setScanBBox] = useState<THREE.Box3 | null>(null);
    const [classificationResults, setClassificationResults] = useState<ClassificationOutput | null>(null);

    // Visualization Toggles
    const [showLowestPoints, setShowLowestPoints] = useState(false);
    const [showVoxels, setShowVoxels] = useState(true);
    const [showCenters, setShowCenters] = useState(true);
    const [showSeeds, setShowSeeds] = useState(true);
    const [showExpansion, setShowExpansion] = useState(false);
    const [expansionSimulator, setExpansionSimulator] = useState<BasinFillSimulator | BasinFillProxy | null>(null);
    const expansionSimulatorRef = useRef<BasinFillSimulator | BasinFillProxy | null>(null);

    // Parameters
    const [voxelSize, setVoxelSize] = useState(0.03);

    // Progress State
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

    // Helper to update status
    const setStatus = (step: number, status: StepStatus) => {
        setSteps(prev => ({ ...prev, [step]: status }));
    };

    const prepareTransformedGeom = useCallback(() => {
        if (!geom || !transform) return null;

        const transformedGeom = geom.geometry.clone();

        const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
            geom.geometry.getAttribute('position') as THREE.BufferAttribute
        );
        const centerOffset = bbox.getCenter(new THREE.Vector3());

        // Center geometry first
        transformedGeom.translate(-centerOffset.x, -centerOffset.y, -centerOffset.z);

        // Apply World Transform (Excluding X/Y translation, as the visualizer handles that via group position)
        const quaternion = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z)
        );
        const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(0, 0, transform.position.z), // Keep Z for lift, but zero X/Y
            quaternion,
            new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z)
        );
        transformedGeom.applyMatrix4(matrix);
        transformedGeom.computeBoundingBox();

        return transformedGeom;
    }, [geom, transform]);

    const runStep1 = useCallback(async (options: VoxelizationOptions = { voxelSize: 0.03 }) => {
        if (!geom) {
            console.warn("No geometry loaded");
            return;
        }

        const transformedGeom = prepareTransformedGeom();
        if (!transformedGeom) return;

        setStatus(1, 'running');
        setProgress({ done: 0, total: 100 });

        // Store bbox for visualization
        const bbox = transformedGeom.boundingBox!;
        setScanBBox(bbox);

        try {
            // STEP 1: VOXELIZATION (Solid Scan)
            // Uses simplified Orchestrator logic (Step 2 in previous version)
            const results = await runIslandScan(
                { geometry: transformedGeom, bbox },
                0.05, // layer height
                {
                    px_mm: options.voxelSize,
                    support_buffer_mm: 0.0,
                    min_island_area_mm2: 0.01
                },
                (done, total) => setProgress({ done, total })
            );

            setScanResults(results);

            setStatus(1, 'complete');
            setCurrentStep(2);
            setProgress(null);

        } catch (e) {
            console.error("Step 1 Failed", e);
            setStatus(1, 'pending');
            setProgress(null);
        }
    }, [geom, prepareTransformedGeom]);

    const runStep2 = useCallback(async () => {
        if (!scanResults) {
            console.warn("No scan results from Step 1");
            return;
        }
        if (!scanBBox) {
            console.warn("No scan bbox");
            return;
        }

        setStatus(2, 'running');
        setProgress({ done: 0, total: 100 });

        try {
            // STEP 2: ANALYSIS (Analyze existing voxels)
            // Import dynamically to avoid circular deps if any
            const { runStep2Analysis } = await import('./steps/Step2_Analysis');

            const { markers, scanResults: analyzedResults } = await runStep2Analysis(
                scanResults,
                {
                    px_mm: scanResults.grid.px_mm,
                    layerHeightMm: 0.05 // Should match Step 1. Ideally stored in results.
                },
                scanBBox.min.z, // Pass the Z offset
                (done, total) => setProgress({ done, total })
            );

            setIslandMarkers(markers);
            setScanResults(analyzedResults); // Update with ID data

            setStatus(2, 'complete');
            setCurrentStep(3);
            setProgress(null);

        } catch (e) {
            console.error("Step 2 Failed", e);
            setStatus(2, 'pending');
            setProgress(null);
        }
    }, [scanResults, scanBBox]);

    const reset = useCallback(() => {
        setSteps({
            1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending',
            5: 'pending', 6: 'pending', 7: 'pending', 8: 'pending'
        });
        setIslandMarkers([]);
        setIslandMarkers([]);
        setScanResults(null);
        setScanResults(null);
        setScanBBox(null);
        setClassificationResults(null);
        setCurrentStep(1);
    }, []);

    const runStep3 = useCallback(async () => {
        if (!scanResults) return;

        setStatus(3, 'running');

        try {
            // STEP 3: INTERNAL CENTER (Pole of Inaccessibility)
            const { InternalCenterFinder } = await import('./steps/Step3_InternalCenter');

            // Note: scanResults.grid has originX/Z. layerHeight needs to be known. 
            // Assuming 0.05 or inferring from scanResults logic if stored? 
            // We unfortunately don't have layerHeight stored in ScanResults explicitly yet, 
            // but we can pass a default or add it. Step 2 used 0.05.
            const layerHeight = 0.05;

            InternalCenterFinder.computeCenters(
                scanResults.islands,
                scanResults.islandLabelsPerLayer,
                scanResults.grid.px_mm,
                scanResults.grid.originX,
                scanResults.grid.originZ,
                layerHeight,
                scanBBox!.min.z // Pass worldMinZ
            );

            // Force update
            setScanResults({ ...scanResults });
            setStatus(3, 'complete');
            setCurrentStep(4);

        } catch (e) {
            console.error("Step 3 Failed", e);
            setStatus(3, 'pending');
        }
    }, [scanResults]);

    const runStep4 = useCallback(async () => {
        if (!scanResults || !scanBBox) return;

        setStatus(4, 'running');

        // Hide standard grid, show expansion
        setShowVoxels(false);
        setShowExpansion(true);

        try {
            const layerHeight = 0.05; // Standard

            // Instantiate Proxy with Worker Factory
            console.log("[useIslandVolumeAnalysis] Creating Worker Proxy...");
            const proxy = new BasinFillProxy(
                {
                    scanResults,
                    layerHeight,
                    minZ: scanBBox.min.z,
                    // Pass standard config explicitly if needed/supported by Proxy constructor logic
                    pxMm: scanResults.grid.px_mm,
                    layerHeightMm: layerHeight
                },
                () => new Worker(new URL('./steps/expansion/expansion.worker.ts', import.meta.url), { type: 'module' })
            );

            expansionSimulatorRef.current = proxy;
            setExpansionSimulator(proxy);

            // Start Worker
            proxy.start();
            console.log("[useIslandVolumeAnalysis] Worker Proxy Started");

        } catch (e) {
            console.error("Step 4 Failed", e);
            setStatus(4, 'pending');
        }
    }, [scanResults, scanBBox]);

    // Step 4 Simulation Loop
    // Step 4 Verification Loop (No Ticking here, just status check)
    useEffect(() => {
        if (steps[4] !== 'running' || !expansionSimulatorRef.current) return;

        const proxy = expansionSimulatorRef.current;
        let handle: number;

        const checkStatus = () => {
            if (proxy.isComplete) {
                console.log("[useIslandVolumeAnalysis] Simulation Complete (Worker)");
                setStatus(4, 'complete');
                setCurrentStep(5);
                proxy.terminate(); // Clean up worker
                return;
            }

            handle = requestAnimationFrame(checkStatus);
        };

        handle = requestAnimationFrame(checkStatus);
        return () => cancelAnimationFrame(handle);
    }, [steps, expansionSimulator]);


    const runStep5 = useCallback(async () => {
        if (!expansionSimulator || !geom || !scanResults || !scanBBox) {
            console.warn("Step 5 prerequisites missing");
            return;
        }

        setStatus(5, 'running');

        try {
            // Need transformed geom again? Or store it?
            // Re-calc for now to be safe/stateless
            const transformedGeom = prepareTransformedGeom();
            if (!transformedGeom) throw new Error("No geometry");

            console.log("[runStep5] Classifying Mesh Faces...");

            const results = MeshClassifier.classify(
                transformedGeom,
                expansionSimulator,
                scanResults.grid.originX,
                scanResults.grid.originZ,
                scanBBox.min.z
            );

            console.log("[runStep5] Classification Complete", results);
            setClassificationResults(results);

            setStatus(5, 'complete');
            setCurrentStep(6);
        } catch (e) {
            console.error("Step 5 Failed", e);
            setStatus(5, 'pending');
        }

    }, [expansionSimulator, geom, scanResults, scanBBox, prepareTransformedGeom]);


    // Visualization Toggles (Continued)


    return {
        currentStep,
        steps,
        islandMarkers,
        scanResults,
        scanBBox,
        classificationResults,
        runStep1,
        runStep2,
        runStep3,
        runStep4,
        runStep5,
        reset,
        showLowestPoints,
        setShowLowestPoints,
        showVoxels,
        setShowVoxels,
        showCenters,
        setShowCenters,
        showSeeds,
        setShowSeeds,
        showExpansion,
        setShowExpansion,
        expansionSimulator, // Return state variable
        voxelSize,
        setVoxelSize,
        progress
    };
}

interface TransformState {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
}

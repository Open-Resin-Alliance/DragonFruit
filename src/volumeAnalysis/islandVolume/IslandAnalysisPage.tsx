import React, { useCallback } from 'react';
import * as THREE from 'three';
import { SceneCanvas } from '@/components/scene/SceneCanvas';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { useStepManager } from './StepManager';
import { runStep1Scan } from './steps/Step1_BasicScan';

export function IslandAnalysisPage() {
    const scene = useSceneCollectionManager();
    const stepManager = useStepManager();

    // Local marker state for visualization
    const [markers, setMarkers] = React.useState<THREE.Vector3[]>([]);

    // Shared geometry for markers
    const sphereGeom = React.useMemo(() => new THREE.SphereGeometry(2, 16, 16), []);

    const handleRunStep1 = useCallback(async () => {
        if (!scene.geom) {
            alert("No geometry loaded!");
            return;
        }

        stepManager.setStepStatus(1, 'running');
        try {
            // Execute Step 1 Logic
            console.log("Starting Step 1 Scan...");
            const lowestPoints = await runStep1Scan(scene.geom.geometry, {
                px_mm: 0.1, // Hardcoded for simplified test
                support_buffer_mm: 0.0, // Strict lowest point
                layerHeightMm: 0.05
            });

            console.log("Step 1 Complete. Found points:", lowestPoints.length);
            stepManager.setStep1Data({ lowestPoints });
            setMarkers(lowestPoints);
            stepManager.setStepStatus(1, 'complete');

        } catch (e) {
            console.error("Step 1 Failed", e);
            stepManager.setStepStatus(1, 'pending');
        }
    }, [scene.geom, stepManager]);

    return (
        <div className="relative h-screen w-screen overflow-hidden bg-neutral-900 text-neutral-100 flex">
            {/* Sidebar Control Panel */}
            <div className="w-80 bg-neutral-800 border-r border-neutral-700 p-4 flex flex-col gap-4 z-10">
                <h1 className="text-xl font-bold mb-4">Island Analysis Workshop</h1>

                <div className="flex flex-col gap-2">
                    {/* Step 1 Control */}
                    <div className="p-3 bg-neutral-700 rounded border border-neutral-600">
                        <div className="flex justify-between items-center mb-2">
                            <span className="font-semibold">Step 1: Basic Scan</span>
                            <div className={`w-3 h-3 rounded-full ${stepManager.steps[1] === 'complete' ? 'bg-green-500' :
                                stepManager.steps[1] === 'running' ? 'bg-yellow-500 animate-pulse' : 'bg-gray-500'
                                }`} />
                        </div>
                        <p className="text-xs text-neutral-400 mb-2">Identify lowest points via RLE scan.</p>
                        <button
                            onClick={handleRunStep1}
                            disabled={stepManager.steps[1] === 'running'}
                            className="w-full py-1 px-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded text-sm transition-colors"
                        >
                            {stepManager.steps[1] === 'running' ? 'Scanning...' : 'Run Step 1'}
                        </button>
                        {stepManager.step1Data && (
                            <div className="mt-2 text-xs text-green-300">
                                Found {stepManager.step1Data.lowestPoints.length} islands
                            </div>
                        )}
                    </div>

                    {/* Placeholders for other steps */}
                    {[2, 3, 4, 5, 6, 7, 8].map(step => (
                        <div key={step} className="p-3 bg-neutral-700/50 rounded border border-neutral-700/50 opacity-50">
                            <span className="font-semibold text-neutral-500">Step {step}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Main Viewport */}
            <div className="flex-1 relative">
                <SceneCanvas
                    models={scene.models}
                    activeModelId={scene.activeModelId}
                    meshColor="#444444"
                    meshVisible={true}
                    // We can use islandMarkers prop for Step 1 visualization!
                    // We map our Vector3s to the format expected: { islandId: number, position: Vector3 }
                    islandMarkers={markers.map((p, i) => ({
                        islandId: i,
                        position: p,
                        // Optional: visual type
                        // We map our Vector3s to the format expected: { id: number, geometry: BufferGeometry }
                        // We must clone and translate the geometry to the correct position because IslandOverlay renders them inside a group
                        islandMarkers={
                            markers.map((p, i) => {
                                const geom = sphereGeom.clone();
                                geom.translate(p.x, p.y, p.z);
                                return {
                                    id: i,
                                    geometry: geom
                                };
                            }) as any
                        }
                        // Note: SceneCanvas expects specific types, we might need to conform or patch it.
                        // Checking SceneCanvas props... it takes 'islandMarkers: IslandMarker[]'
                        />

                        {/* Step 1 Check Overlay */ }
                {
                            stepManager.steps[1] === 'complete' && markers.length > 0 && (
                                <div className="absolute top-4 left-4 bg-black/70 p-2 rounded text-green-400 pointer-events-none">
                                    ✓ Step 1 Visualized: {markers.length} Lowest Points
                                </div>
                            )
                        }
            </div>
        </div>
    );
}

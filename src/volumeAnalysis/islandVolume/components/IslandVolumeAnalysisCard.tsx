import React from 'react';
import type { IslandVolumeAnalysisState } from '../useIslandVolumeAnalysis';
import { NumberInput } from '@/components/ui/NumberInput';

interface Props {
    state: IslandVolumeAnalysisState;
}

export function IslandVolumeAnalysisCard({ state }: Props) {
    const { steps, runStep1, islandMarkers, showLowestPoints, setShowLowestPoints, reset, progress } = state;

    return (
        <div className="bg-neutral-800 border border-neutral-700 rounded-lg p-4 shadow-xl w-full max-w-sm pointer-events-auto flex flex-col gap-3">
            <div className="flex justify-between items-center border-b border-neutral-700 pb-2">
                <h2 className="font-bold text-neutral-100">Island Volume Analysis</h2>
                <button onClick={reset} className="text-xs text-red-400 hover:text-red-300">Reset</button>
            </div>

            {/* Step 1: Voxelization */}
            <div className={`p-3 rounded border transition-colors ${steps[1] === 'running' ? 'bg-blue-900/30 border-blue-700' :
                steps[1] === 'complete' ? 'bg-green-900/20 border-green-700' :
                    'bg-neutral-700 border-neutral-600'
                }`}>
                <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold text-sm">Step 1: Voxelization</span>
                    {steps[1] === 'complete' && <span className="text-green-400 text-xs">✓ Done</span>}
                </div>

                <p className="text-xs text-neutral-400 mb-2">Generate voxel grid from mesh volume.</p>

                <div className="flex items-center gap-2 mb-2">
                    <label className="text-xs text-neutral-400">Voxel Size (mm):</label>
                    <NumberInput
                        step="0.1"
                        min="0.1"
                        max="10.0"
                        value={state.voxelSize}
                        onChange={(next) => state.setVoxelSize(next)}
                        disabled={steps[1] === 'running' || steps[1] === 'complete'}
                        className="w-16 bg-neutral-900 border border-neutral-700 rounded pl-1.5 pr-5 py-0.5 text-xs text-right"
                    />
                </div>

                <div className="flex flex-col gap-2">
                    <button
                        onClick={() => runStep1({ voxelSize: state.voxelSize })}
                        disabled={steps[1] === 'running' || steps[1] === 'complete'}
                        className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:text-neutral-400 rounded text-xs font-medium transition-colors"
                    >
                        {steps[1] === 'running' ? 'Voxelizing...' : 'Run Step 1'}
                    </button>

                    {progress && steps[1] === 'running' && (
                        <div className="w-full h-1 bg-neutral-600 rounded overflow-hidden">
                            <div className="h-full bg-blue-400" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                        </div>
                    )}

                    {steps[1] === 'complete' && (
                        <button
                            onClick={() => state.setShowVoxels(!state.showVoxels)}
                            className={`px-3 rounded border text-xs font-medium ${state.showVoxels ? 'bg-green-600 border-green-500 text-white' : 'bg-neutral-700 border-neutral-500 text-neutral-300'
                                }`}
                            title="Toggle Voxel Visualization"
                        >
                            👁 Grid
                        </button>
                    )}
                </div>
            </div>

            {/* Step 2: Island Analysis */}
            <div className={`p-3 rounded border transition-colors ${steps[2] === 'running' ? 'bg-blue-900/30 border-blue-700' :
                steps[2] === 'complete' ? 'bg-green-900/20 border-green-700' :
                    steps[1] === 'complete' ? 'bg-neutral-700 border-neutral-600' : 'bg-neutral-800 border-neutral-700 opacity-50'
                }`}>
                <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold text-sm">Step 2: Island Analysis</span>
                    {steps[2] === 'complete' && <span className="text-green-400 text-xs">✓ Done</span>}
                </div>

                <p className="text-xs text-neutral-400 mb-3">Identify islands and lowest points from voxels.</p>

                <div className="flex flex-col gap-2">
                    <button
                        onClick={() => state.runStep2()}
                        disabled={steps[1] !== 'complete' || steps[2] === 'running' || steps[2] === 'complete'}
                        className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:text-neutral-400 rounded text-xs font-medium transition-colors"
                    >
                        {steps[2] === 'running' ? 'Analyzing...' : 'Run Analysis'}
                    </button>

                    {progress && steps[2] === 'running' && (
                        <div className="w-full h-1 bg-neutral-600 rounded overflow-hidden">
                            <div className="h-full bg-blue-400" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                        </div>
                    )}

                    {steps[2] === 'complete' && (
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowLowestPoints(!showLowestPoints)}
                                className={`flex-1 px-3 py-1 rounded border text-xs font-medium ${showLowestPoints ? 'bg-green-600 border-green-500 text-white' : 'bg-neutral-700 border-neutral-500 text-neutral-300'
                                    }`}
                                title="Toggle Start Points"
                            >
                                👁 Red Overlays
                            </button>
                        </div>
                    )}
                </div>

                {steps[2] === 'complete' && (
                    <div className="mt-2 text-xs text-neutral-300 bg-neutral-900/50 p-1.5 rounded">
                        Found <strong>{islandMarkers.length}</strong> islands.
                    </div>
                )}
            </div>

            {/* Step 3: Internal Center */}
            <div className={`p-3 rounded border transition-colors ${steps[3] === 'running' ? 'bg-blue-900/30 border-blue-700' :
                steps[3] === 'complete' ? 'bg-green-900/20 border-green-700' :
                    steps[2] === 'complete' ? 'bg-neutral-700 border-neutral-600' : 'bg-neutral-800 border-neutral-700 opacity-50'
                }`}>
                <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold text-sm">Step 3: Internal Center</span>
                    {steps[3] === 'complete' && <span className="text-green-400 text-xs">✓ Done</span>}
                </div>

                <p className="text-xs text-neutral-400 mb-3">Identify the "deepest" point (Pole of Inaccessibility) for each island.</p>

                <div className="flex flex-col gap-2">
                    <button
                        onClick={() => state.runStep3?.()} // Optional chaining key during dev
                        disabled={steps[2] !== 'complete' || steps[3] === 'running' || steps[3] === 'complete'}
                        className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:text-neutral-400 rounded text-xs font-medium transition-colors"
                    >
                        {steps[3] === 'running' ? 'Calculating...' : 'Find Centers'}
                    </button>

                    {steps[3] === 'complete' && (
                        <div className="flex gap-2">
                            <button
                                onClick={() => state.setShowCenters(!state.showCenters)}
                                className={`flex-1 px-3 py-1 rounded border text-xs font-medium ${state.showCenters ? 'bg-yellow-600 border-yellow-500 text-white' : 'bg-neutral-700 border-neutral-500 text-neutral-300'
                                    }`}
                                title="Toggle Yellow Internal Centers"
                            >
                                👁 Centers
                            </button>
                            <button
                                onClick={() => state.setShowSeeds(!state.showSeeds)}
                                className={`flex-1 px-3 py-1 rounded border text-xs font-medium ${state.showSeeds ? 'bg-green-600 border-green-500 text-white' : 'bg-neutral-700 border-neutral-500 text-neutral-300'
                                    }`}
                                title="Toggle Green Seed Voxels"
                            >
                                👁 Seeds
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Step 4: Basin Expansion */}
            <div className={`p-3 rounded border transition-colors ${steps[4] === 'running' ? 'bg-blue-900/30 border-blue-700' :
                steps[4] === 'complete' ? 'bg-green-900/20 border-green-700' :
                    steps[3] === 'complete' ? 'bg-neutral-700 border-neutral-600' : 'bg-neutral-800 border-neutral-700 opacity-50'
                }`}>
                <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold text-sm">Step 4: Basin Expansion</span>
                    {steps[4] === 'complete' && <span className="text-green-400 text-xs">✓ Done</span>}
                </div>

                <p className="text-xs text-neutral-400 mb-3">Expand territories from seeds to fill volume (Voronoi-like).</p>

                <div className="flex flex-col gap-2">
                    <button
                        onClick={() => state.runStep4?.()}
                        disabled={steps[3] !== 'complete' || steps[4] === 'running' || steps[4] === 'complete'}
                        className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:text-neutral-400 rounded text-xs font-medium transition-colors"
                    >
                        {steps[4] === 'running' ? 'Expanding...' : 'Start Expansion'}
                    </button>

                    {(steps[4] === 'complete' || steps[4] === 'running') && (
                        <div className="flex gap-2">
                            <button
                                onClick={() => state.setShowExpansion(!state.showExpansion)}
                                className={`flex-1 px-3 py-1 rounded border text-xs font-medium ${state.showExpansion ? 'bg-green-600 border-green-500 text-white' : 'bg-neutral-700 border-neutral-500 text-neutral-300'
                                    }`}
                                title="Toggle Expansion Visualization"
                            >
                                👁 Expansion
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Step 5: Mesh Classification */}
            <div className={`p-3 rounded border transition-colors ${steps[5] === 'running' ? 'bg-blue-900/30 border-blue-700' :
                steps[5] === 'complete' ? 'bg-green-900/20 border-green-700' :
                    steps[4] === 'complete' ? 'bg-neutral-700 border-neutral-600' : 'bg-neutral-800 border-neutral-700 opacity-50'
                }`}>
                <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold text-sm">Step 5: Mesh Classification</span>
                    {steps[5] === 'complete' && <span className="text-green-400 text-xs">✓ Done</span>}
                </div>

                <p className="text-xs text-neutral-400 mb-3">Map mesh triangles to island volumes.</p>

                <div className="flex flex-col gap-2">
                    <button
                        onClick={() => state.runStep5?.()}
                        disabled={steps[4] !== 'complete' || steps[5] === 'running' || steps[5] === 'complete'}
                        className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:text-neutral-400 rounded text-xs font-medium transition-colors"
                    >
                        {steps[5] === 'running' ? 'Classifying...' : 'Classify Mesh'}
                    </button>

                    {/* Results Display */}
                    {state.classificationResults && (
                        <div className="max-h-32 overflow-y-auto bg-neutral-900/50 rounded p-2 text-xs">
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="text-neutral-500 border-b border-neutral-700">
                                        <th className="pb-1">Island</th>
                                        <th className="pb-1 text-right">Faces</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {Array.from(state.classificationResults.summary.values()).map(res => (
                                        <tr key={res.islandId} className="border-b border-neutral-800 last:border-0 hover:bg-neutral-800/50">
                                            <td className="py-1">
                                                <span className="inline-block w-2 h-2 rounded-full mr-2"
                                                    style={{
                                                        backgroundColor: res.islandId === 0 ? '#333' :
                                                            `hsl(${(res.islandId * 0.618033988749895 * 360) % 360}, 80%, 60%)`
                                                    }}
                                                />
                                                {res.islandId === 0 ? 'Body/Void' : `Island ${res.islandId}`}
                                            </td>
                                            <td className="py-1 text-right font-mono text-neutral-300">{res.faceCount.toLocaleString()}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {/* Placeholders for Future Steps */}
            {[6, 7, 8].map(step => (
                <div key={step} className="p-3 bg-neutral-700/30 rounded border border-neutral-700/30 opacity-60">
                    <div className="flex justify-between items-center">
                        <span className="font-semibold text-sm text-neutral-500">Step {step}</span>
                        <span className="text-xs text-neutral-600">Pending</span>
                    </div>
                </div>
            ))}

        </div>
    );
}

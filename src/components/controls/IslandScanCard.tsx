import React from 'react';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
import { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { NumberInput } from '@/components/ui/NumberInput';
import type { ImportPhase } from '@/features/lys-conversion/useLycheeImport';

interface IslandScanCardProps {
    islands: ReturnType<typeof useIslandManager>;
    hasGeometry: boolean;
    onLoadLychee: () => void;
    onGhostDataLoaded?: (data: any) => void;
    onImportLycheeFile?: (file: File) => void;
    // Two-step Lychee import
    lycheeImportPhase?: ImportPhase;
    lycheeImportError?: string | null;
    onLycheeJsonFile?: (file: File) => void;
    onLycheeStlFile?: (file: File) => void;
    onCancelLycheeImport?: () => void;
}

export function IslandScanCard({
    islands,
    hasGeometry,
    onLoadLychee,
    onGhostDataLoaded,
    onImportLycheeFile,
    // Two-step import props
    lycheeImportPhase = 'idle',
    lycheeImportError,
    onLycheeJsonFile,
    onLycheeStlFile,
    onCancelLycheeImport
}: IslandScanCardProps) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const stlInputRef = React.useRef<HTMLInputElement>(null);

    // Determine if we're using the new two-step flow
    const useTwoStepFlow = !!onLycheeJsonFile && !!onLycheeStlFile;

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = ''; // Reset for re-selection

        // Two-step flow: JSON file
        if (useTwoStepFlow && onLycheeJsonFile) {
            onLycheeJsonFile(file);
            return;
        }

        if (onImportLycheeFile) {
            onImportLycheeFile(file);
            return;
        }

        if (onGhostDataLoaded) {
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const json = JSON.parse(event.target?.result as string);
                    console.log('[IslandScanCard] Loaded Ghost JSON:', json);
                    onGhostDataLoaded(json);
                } catch (err) {
                    console.error('Failed to parse JSON', err);
                }
            };
            reader.readAsText(file);
        }
    };

    const handleStlFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = ''; // Reset for re-selection

        if (onLycheeStlFile) {
            onLycheeStlFile(file);
        }
    };

    return (
        <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl space-y-1">
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".json,.lys"
                onChange={handleFileChange}
            />
            <input
                type="file"
                ref={stlInputRef}
                className="hidden"
                accept=".stl"
                onChange={handleStlFileChange}
            />
            <div className="flex items-center justify-between py-1 border-b border-neutral-700">
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => islands.setScanCardExpanded(!islands.scanCardExpanded)}
                        className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
                        title={islands.scanCardExpanded ? 'Collapse card' : 'Expand card'}
                    >
                        <svg
                            className={`w-3 h-3 transform transition-transform ${islands.scanCardExpanded ? 'text-blue-500 rotate-0' : 'text-neutral-500 rotate-0'}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            {islands.scanCardExpanded ? (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            ) : (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            )}
                        </svg>
                    </button>
                    <h3 className="text-xs font-semibold text-neutral-200">Island Scan</h3>
                </div>

                <div className="flex gap-1.5">
                    <button
                        type="button"
                        onClick={islands.onRunIslandScan}
                        disabled={!hasGeometry || islands.scanning}
                        className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 disabled:opacity-50 transition-colors"
                    >
                        {islands.scanning ? 'Scanning…' : 'Scan'}
                    </button>
                    <button
                        type="button"
                        onClick={islands.onRunScanlineScan}
                        disabled={!hasGeometry || islands.scanning}
                        className="px-1.5 py-0.5 text-[10px] rounded bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:opacity-50 text-white transition-colors"
                        title="Run optimized scanline rasterization"
                    >
                        {islands.scanning ? '...' : 'Scanline'}
                    </button>
                </div>
            </div>

            <div className="pt-1">
                {/* Two-step import: Awaiting STL phase */}
                {useTwoStepFlow && lycheeImportPhase === 'awaiting_stl' ? (
                    <div className="space-y-1">
                        <div className="text-[10px] text-yellow-400 px-1">
                            JSON loaded. Now select the original STL file.
                        </div>
                        <div className="flex gap-1">
                            <button
                                onClick={() => stlInputRef.current?.click()}
                                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded text-[10px] font-medium transition-colors"
                            >
                                Select STL File
                            </button>
                            <button
                                onClick={onCancelLycheeImport}
                                className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px] transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : lycheeImportPhase === 'processing' ? (
                    <div className="text-[10px] text-blue-400 px-1 py-1">
                        Processing import...
                    </div>
                ) : (
                    <button
                        onClick={() => {
                            if (useTwoStepFlow || onImportLycheeFile || onGhostDataLoaded) {
                                fileInputRef.current?.click();
                            } else {
                                onLoadLychee();
                            }
                        }}
                        className="w-full bg-green-600 hover:bg-green-500 text-white px-2 py-1 rounded text-[10px] font-medium transition-colors mb-1"
                    >
                        Load Support Data (V2)
                    </button>
                )}

                {/* Error display */}
                {lycheeImportError && (
                    <div className="text-[10px] text-red-400 px-1 mt-1">
                        {lycheeImportError}
                    </div>
                )}
            </div>

            {islands.scanProgress && (
                <div className="text-[10px] text-neutral-400 px-1">
                    {islands.scanProgress.done} / {islands.scanProgress.total} layers
                    {islands.scanData && islands.scanData.islands.length > 0 && (
                        <span className="text-neutral-300 ml-1">({islands.scanData.islands.length} islands)</span>
                    )}
                </div>
            )}

            {islands.scanCardExpanded && (
                <div className="bg-neutral-750 rounded p-1 mt-1">
                    <div className="grid grid-cols-2 gap-1.5">
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] text-neutral-400">Pixel (mm)</label>
                            <NumberInput
                                value={islands.pxMm}
                                onChange={(val) => {
                                    if (val >= 0.01 && val <= 0.5) {
                                        islands.setPxMm(val);
                                    }
                                }}
                                className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                            />
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] text-neutral-400">Buffer (mm)</label>
                            <NumberInput
                                value={islands.supportBufMm}
                                onChange={(val) => {
                                    if (val >= 0 && val <= 2) {
                                        islands.setSupportBufMm(val);
                                    }
                                }}
                                className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                            />
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] text-neutral-400">Connectivity</label>
                            <div className="flex rounded bg-neutral-700 p-0.5">
                                <button
                                    onClick={() => islands.setConnectivity(4)}
                                    className={`flex-1 text-[9px] rounded py-0.5 ${islands.connectivity === 4 ? 'bg-blue-500 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
                                >
                                    4
                                </button>
                                <button
                                    onClick={() => islands.setConnectivity(8)}
                                    className={`flex-1 text-[9px] rounded py-0.5 ${islands.connectivity === 8 ? 'bg-blue-500 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
                                >
                                    8
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] text-neutral-400">Min Area (mm²)</label>
                            <NumberInput
                                value={islands.minIslandAreaMm2}
                                onChange={(val) => {
                                    if (val >= 0 && val <= 10) {
                                        islands.setMinIslandAreaMm2(val);
                                    }
                                }}
                                className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                            />
                        </div>

                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] text-neutral-400">Min Overlap (px)</label>
                            <NumberInput
                                value={islands.minOverlapPx}
                                onChange={(val) => {
                                    if (val >= 1 && val <= 1000) {
                                        islands.setMinOverlapPx(val);
                                    }
                                }}
                                className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                            />
                        </div>

                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] text-neutral-400">Overlap Radius (px)</label>
                            <NumberInput
                                value={islands.overlapNeighborhoodPx}
                                onChange={(val) => {
                                    if (val >= 0 && val <= 25) {
                                        islands.setOverlapNeighborhoodPx(val);
                                    }
                                }}
                                className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                            />
                        </div>
                    </div>

                    {/* Debug options */}
                    <div className="mt-1 pt-1 border-t border-neutral-700 flex items-center justify-between">
                        <label className="text-[9px] text-neutral-400">Show Island IDs (debug)</label>
                        <button
                            type="button"
                            onClick={() => islands.setShowIslandIdLabels(!islands.showIslandIdLabels)}
                            className={`w-7 h-4 rounded-full flex items-center px-0.5 transition-colors ${islands.showIslandIdLabels ? 'bg-blue-500' : 'bg-neutral-600'
                                }`}
                        >
                            <span
                                className={`w-3 h-3 rounded-full bg-white shadow transform transition-transform ${islands.showIslandIdLabels ? 'translate-x-3' : 'translate-x-0'
                                    }`}
                            />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
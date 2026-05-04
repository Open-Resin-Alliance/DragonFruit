import React from 'react';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
import { NumberInput } from '@/components/ui/NumberInput';
import { Search, ScanLine, Cpu } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';

type ImportPhase = 'idle' | 'awaiting_stl' | 'processing';

interface IslandScanCardProps {
    islands: ReturnType<typeof useIslandManager>;
    hasGeometry: boolean;
    onLoadSupportJson: () => void;
    onGhostDataLoaded?: (data: unknown) => void;
    onImportSupportFile?: (file: File) => void;
    // Two-step plugin import
    pluginImportPhase?: ImportPhase;
    pluginImportError?: string | null;
    onPluginJsonFile?: (file: File) => void;
    onPluginStlFile?: (file: File) => void;
    onCancelPluginImport?: () => void;
}

export function IslandScanCard({
    islands,
    hasGeometry,
    onLoadSupportJson,
    onGhostDataLoaded,
    onImportSupportFile,
    // Two-step import props
    pluginImportPhase = 'idle',
    pluginImportError,
    onPluginJsonFile,
    onPluginStlFile,
    onCancelPluginImport
}: IslandScanCardProps) {
    const cardRef = React.useRef<HTMLDivElement | null>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const stlInputRef = React.useRef<HTMLInputElement>(null);
    const [compactActions, setCompactActions] = React.useState(false);

    // Determine if we're using the new two-step flow
    const useTwoStepFlow = !!onPluginJsonFile && !!onPluginStlFile;

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = ''; // Reset for re-selection

        // Two-step flow: JSON file
        if (useTwoStepFlow && onPluginJsonFile) {
            onPluginJsonFile(file);
            return;
        }

        if (onImportSupportFile) {
            onImportSupportFile(file);
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

        if (onPluginStlFile) {
            onPluginStlFile(file);
        }
    };

    React.useLayoutEffect(() => {
        const element = cardRef.current;
        if (!element) return;

        const updateCompactState = () => {
            setCompactActions(element.clientWidth <= 276);
        };

        updateCompactState();
        const observer = new ResizeObserver(updateCompactState);
        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    return (
        <div ref={cardRef}>
        <Card>
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
            <CardHeader
                left={(
                    <>
                        <IconButton
                        onClick={() => islands.setScanCardExpanded(!islands.scanCardExpanded)}
                        className="!p-0.5"
                        title={islands.scanCardExpanded ? 'Collapse card' : 'Expand card'}
                    >
                        <svg
                            className="w-3 h-3 transform transition-transform"
                            style={{ color: islands.scanCardExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
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
                        </IconButton>
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Island Scan</h3>
                    </>
                )}
                right={(
                    <div className="flex gap-1.5">
                        <Button
                            onClick={islands.onRunNativeIslandScan}
                            disabled={!hasGeometry || islands.scanning}
                            variant="accent"
                            size="sm"
                            className={compactActions ? '!h-8 !w-8 !min-w-8 !px-0 !py-0 !inline-flex !items-center !justify-center !leading-none text-[11px]' : '!h-8 !px-2.5 !py-0 text-[11px]'}
                            title="Run native Rust island scan (fastest)"
                        >
                            {compactActions
                                ? (islands.scanning ? '…' : <Cpu className="h-3.5 w-3.5" />)
                                : (islands.scanning ? 'Scanning…' : 'Native')}
                        </Button>
                        <Button
                            onClick={islands.onRunScanlineScan}
                            disabled={!hasGeometry || islands.scanning}
                            variant="secondary"
                            size="sm"
                            className={compactActions ? '!h-8 !w-8 !min-w-8 !px-0 !py-0 !inline-flex !items-center !justify-center !leading-none text-[11px]' : '!h-8 !px-2.5 !py-0 text-[11px]'}
                            title="Run TypeScript scanline scan"
                        >
                            {compactActions
                                ? (islands.scanning ? '…' : <ScanLine className="h-3.5 w-3.5" />)
                                : (islands.scanning ? '...' : 'JS')}
                        </Button>
                    </div>
                )}
                hideDivider={!islands.scanCardExpanded}
            />

            <div className="px-2.5 pt-1 pb-2.5 space-y-1.5">
            <div>
                {/* Two-step import: Awaiting STL phase */}
                {useTwoStepFlow && pluginImportPhase === 'awaiting_stl' ? (
                    <div className="space-y-1">
                        <div className="text-[11px] px-1" style={{ color: 'var(--text-strong)' }}>
                            JSON loaded. Now select the original STL file.
                        </div>
                        <div className="flex gap-1">
                            <Button
                                onClick={() => stlInputRef.current?.click()}
                                variant="primary"
                                size="sm"
                                className="flex-1 !h-8 text-[11px]"
                            >
                                Select STL File
                            </Button>
                            <Button
                                onClick={onCancelPluginImport}
                                variant="secondary"
                                size="sm"
                                className="!h-8 text-[11px]"
                            >
                                Cancel
                            </Button>
                        </div>
                    </div>
                ) : pluginImportPhase === 'processing' ? (
                    <div className="text-[11px] px-1 py-1" style={{ color: 'var(--text-muted)' }}>
                        Processing import...
                    </div>
                ) : (
                    <Button
                        onClick={() => {
                            if (useTwoStepFlow || onImportSupportFile || onGhostDataLoaded) {
                                fileInputRef.current?.click();
                            } else {
                                onLoadSupportJson();
                            }
                        }}
                        variant="primary"
                        className="w-full mb-1 !h-8 text-[11px]"
                    >
                        Load Support Data (V2)
                    </Button>
                )}

                {/* Error display */}
                {pluginImportError && (
                    <div className="text-[11px] px-1 mt-1" style={{ color: 'var(--danger)' }}>
                        {pluginImportError}
                    </div>
                )}
            </div>

            {islands.scanProgress && (
                <div className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>
                    {islands.scanProgress.done} / {islands.scanProgress.total} layers
                    {islands.scanData && islands.scanData.islands.length > 0 && (
                        <span className="ml-1" style={{ color: 'var(--text-strong)' }}>({islands.scanData.islands.length} islands)</span>
                    )}
                </div>
            )}

            {islands.scanCardExpanded && (
                <div className="rounded p-1 mt-1 border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}>
                    <div className="grid grid-cols-2 gap-1.5">
                        <div className="flex flex-col gap-0.5">
                            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Pixel (mm)</label>
                            <NumberInput
                                value={islands.pxMm}
                                onChange={(val) => {
                                    if (val >= 0.01 && val <= 0.5) {
                                        islands.setPxMm(val);
                                    }
                                }}
                                className="ui-input w-full !h-8 px-2 text-sm no-spinners"
                            />
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Buffer (mm)</label>
                            <NumberInput
                                value={islands.supportBufMm}
                                onChange={(val) => {
                                    if (val >= 0 && val <= 2) {
                                        islands.setSupportBufMm(val);
                                    }
                                }}
                                className="ui-input w-full !h-8 px-2 text-sm no-spinners"
                            />
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Connectivity</label>
                            <div className="flex rounded p-0.5 gap-0.5" style={{ background: 'var(--surface-2)' }}>
                                <Button
                                    onClick={() => islands.setConnectivity(4)}
                                    variant={islands.connectivity === 4 ? 'primary' : 'secondary'}
                                    size="sm"
                                    className="flex-1 !h-8 !py-0 text-[11px]"
                                >
                                    4
                                </Button>
                                <Button
                                    onClick={() => islands.setConnectivity(8)}
                                    variant={islands.connectivity === 8 ? 'primary' : 'secondary'}
                                    size="sm"
                                    className="flex-1 !h-8 !py-0 text-[11px]"
                                >
                                    8
                                </Button>
                            </div>
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Min Area (mm²)</label>
                            <NumberInput
                                value={islands.minIslandAreaMm2}
                                onChange={(val) => {
                                    if (val >= 0 && val <= 10) {
                                        islands.setMinIslandAreaMm2(val);
                                    }
                                }}
                                className="ui-input w-full !h-8 px-2 text-sm no-spinners"
                            />
                        </div>

                        <div className="flex flex-col gap-0.5">
                            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Min Overlap (px)</label>
                            <NumberInput
                                value={islands.minOverlapPx}
                                onChange={(val) => {
                                    if (val >= 1 && val <= 1000) {
                                        islands.setMinOverlapPx(val);
                                    }
                                }}
                                className="ui-input w-full !h-8 px-2 text-sm no-spinners"
                            />
                        </div>

                        <div className="flex flex-col gap-0.5">
                            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Overlap Radius (px)</label>
                            <NumberInput
                                value={islands.overlapNeighborhoodPx}
                                onChange={(val) => {
                                    if (val >= 0 && val <= 25) {
                                        islands.setOverlapNeighborhoodPx(val);
                                    }
                                }}
                                className="ui-input w-full !h-8 px-2 text-sm no-spinners"
                            />
                        </div>
                    </div>

                    {/* Debug options */}
                    <div className="mt-1 pt-1 border-t flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)' }}>
                        <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Show Island IDs (debug)</label>
                        <button
                            type="button"
                            onClick={() => islands.setShowIslandIdLabels(!islands.showIslandIdLabels)}
                            className="w-9 h-5 rounded-full flex items-center px-0.5 transition-colors"
                            style={{
                                background: islands.showIslandIdLabels ? 'var(--accent)' : 'var(--surface-2)',
                            }}
                        >
                            <span
                                className={`w-4 h-4 rounded-full bg-white shadow transform transition-transform ${islands.showIslandIdLabels ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                            />
                        </button>
                    </div>
                </div>
            )}
            </div>
        </Card>
        </div>
    );
}
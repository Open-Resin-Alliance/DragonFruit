import React, { useSyncExternalStore } from 'react';
import type { SupportState } from '../types';
import { subscribe, getSnapshot, updateTrunk } from '../state';
import { updateCurveTension, removeCurveAtJoint, updateSegmentTension, removeSegmentCurve, updateSegmentBias } from './curveUtils';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../history/supportEditHistory';
import { Button } from '@/components/ui/primitives';

type CurveSelectionState = {
    selectedId: string;
    category: 'joint' | 'segment';
    selectedTrunk: SupportState['trunks'][string];
    selectedSegmentId: string | null;
    currentTension: number;
    currentBias: number;
};

export function getCurveSettingsSelection(state: SupportState): CurveSelectionState | null {
    const selectedId = state.selectedId;
    const category = state.selectedCategory;

    if ((category !== 'joint' && category !== 'segment') || !selectedId) return null;

    // Find the trunk containing this joint/segment
    const trunks = Object.values(state.trunks);
    let selectedTrunk: SupportState['trunks'][string] | null = null;
    let isBezier = false;
    let currentTension = 0.5;
    let currentBias = 0.5;
    let selectedSegmentId: string | null = null;

    if (category === 'segment') {
        for (const trunk of trunks) {
            const seg = trunk.segments.find(s => s.id === selectedId);
            if (seg) {
                selectedTrunk = trunk;
                selectedSegmentId = seg.id;
                if (seg.type === 'bezier') {
                    isBezier = true;
                    currentTension = seg.tension;
                    currentBias = seg.bias ?? 0.5;
                }
                break;
            }
        }
    } else {
        // Joint Logic
        for (const trunk of trunks) {
            for (const seg of trunk.segments) {
                 if (seg.topJoint?.id === selectedId || seg.bottomJoint?.id === selectedId) {
                     selectedTrunk = trunk;
                     if (seg.type === 'bezier') {
                         isBezier = true;
                         currentTension = seg.tension;
                         currentBias = seg.bias ?? 0.5;
                     }
                 }
            }
            if (selectedTrunk) break;
        }
    }
    
    if (!selectedTrunk || !isBezier) return null;

    return {
        selectedId,
        category,
        selectedTrunk,
        selectedSegmentId,
        currentTension,
        currentBias,
    };
}

export function CurveSettingsCard({ embedded = false }: { embedded?: boolean }) {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selection = getCurveSettingsSelection(state);

    if (!selection) {
        return (
            <div className="space-y-2 p-3 rounded-md border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Curve Settings</div>
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    Select a curve segment or joint in the viewport to adjust tension, bias, and remove curves.
                </div>
            </div>
        );
    }

    const {
        selectedId,
        category,
        selectedTrunk,
        selectedSegmentId,
        currentTension,
        currentBias,
    } = selection;

    const handleTensionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        if (selectedTrunk) {
            const before = captureSupportEditSnapshot();
            const root = state.roots[selectedTrunk.rootId];
            if (!root) return;
            
            let newTrunk;
            if (category === 'segment' && selectedSegmentId) {
                newTrunk = updateSegmentTension(selectedTrunk, selectedSegmentId, val, root);
            } else {
                newTrunk = updateCurveTension(selectedTrunk, selectedId!, val, root);
            }
            updateTrunk(newTrunk);
            pushSupportEditHistory('Adjust curve tension', before, captureSupportEditSnapshot());
        }
    };

    const handleBiasChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        if (selectedTrunk) {
            const before = captureSupportEditSnapshot();
            const root = state.roots[selectedTrunk.rootId];
            if (!root) return;
            
            let newTrunk;
            if (category === 'segment' && selectedSegmentId) {
                newTrunk = updateSegmentBias(selectedTrunk, selectedSegmentId, val, root);
            } else {
                // Loop here for simplicity
                newTrunk = { ...selectedTrunk };
                for (const seg of selectedTrunk.segments) {
                    if ((seg.topJoint?.id === selectedId || seg.bottomJoint?.id === selectedId) && seg.type === 'bezier') {
                        newTrunk = updateSegmentBias(newTrunk, seg.id, val, root);
                    }
                }
            }
            updateTrunk(newTrunk);
            pushSupportEditHistory('Adjust curve bias', before, captureSupportEditSnapshot());
        }
    };

    const handleRemoveCurve = () => {
        if (selectedTrunk) {
            const before = captureSupportEditSnapshot();
            let newTrunk;
            if (category === 'segment' && selectedSegmentId) {
                newTrunk = removeSegmentCurve(selectedTrunk, selectedSegmentId);
            } else {
                newTrunk = removeCurveAtJoint(selectedTrunk, selectedId!);
            }
            updateTrunk(newTrunk);
            pushSupportEditHistory('Remove curve', before, captureSupportEditSnapshot());
        }
    };

    const selectedLabel = category === 'segment' ? 'Segment curve' : 'Joint curve';
    const selectedDisplay = selectedSegmentId || selectedId;

    const content = (
        <div className="space-y-3">
            <div className="flex justify-between items-center">
                <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Curve Settings</div>
                <div className="text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>{selectedLabel}</div>
            </div>

            <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="text-[11px] text-zinc-200 truncate" title={selectedDisplay}>{selectedDisplay}</div>
            </div>

            <div className="space-y-2">
                <div className="space-y-1 min-w-0">
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Tension</div>
                    <div className="flex gap-2 items-center">
                        <input
                            type="range"
                            min="0.1"
                            max="2.0"
                            step="0.1"
                            value={currentTension}
                            onChange={handleTensionChange}
                            className="flex-1 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                        />
                        <div className="w-11 text-right text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{currentTension.toFixed(2)}</div>
                    </div>
                </div>

                <div className="space-y-1 min-w-0">
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Bias (Bottom - Top)</div>
                    <div className="flex gap-2 items-center">
                        <input
                            type="range"
                            min="0.3"
                            max="0.7"
                            step="0.05"
                            value={currentBias}
                            onChange={handleBiasChange}
                            className="flex-1 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                        <div className="w-11 text-right text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{currentBias.toFixed(2)}</div>
                    </div>
                </div>

                <div className="pt-2">
                    <Button
                        type="button"
                        onClick={handleRemoveCurve}
                        variant="danger"
                        size="md"
                        className="w-full h-9 text-[12px] font-semibold"
                    >
                        Remove Curve
                    </Button>
                </div>
            </div>
        </div>
    );

    if (embedded) {
        return content;
    }

    return (
        <div className="absolute top-20 left-[340px] bg-zinc-900/90 backdrop-blur-sm border border-zinc-700/50 p-4 rounded-lg shadow-xl w-64 pointer-events-auto z-50">
            <h3 className="text-zinc-200 font-medium mb-3 text-sm">Curve Settings</h3>
            {content}
        </div>
    );
}

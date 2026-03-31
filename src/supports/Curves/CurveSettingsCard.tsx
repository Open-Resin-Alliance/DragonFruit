import React, { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, updateTrunk } from '../state';
import { updateCurveTension, removeCurveAtJoint, updateSegmentTension, removeSegmentCurve, updateSegmentBias } from './curveUtils';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../history/supportEditHistory';

export function CurveSettingsCard() {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    const category = state.selectedCategory;

    if ((category !== 'joint' && category !== 'segment') || !selectedId) return null;

    // Find the trunk containing this joint/segment
    const trunks = Object.values(state.trunks);
    let selectedTrunk = null;
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

    return (
        <div className="absolute top-20 left-[340px] bg-zinc-900/90 backdrop-blur-sm border border-zinc-700/50 p-4 rounded-lg shadow-xl w-64 pointer-events-auto z-50">
            <h3 className="text-zinc-200 font-medium mb-3 text-sm">Curve Settings</h3>
            
            <div className="space-y-4">
                {/* Tightness Slider */}
                <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-xs text-zinc-400">
                        <span>Tightness</span>
                        <span>{currentTension.toFixed(1)}</span>
                    </div>
                    <input 
                        type="range" 
                        min="0.1" 
                        max="2.0" 
                        step="0.1"
                        value={currentTension}
                        onChange={handleTensionChange}
                        className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                    />
                </div>

                {/* Bias Slider */}
                <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-xs text-zinc-400">
                        <span>Bias (Bottom - Top)</span>
                        <span>{currentBias.toFixed(2)}</span>
                    </div>
                    <input 
                        type="range" 
                        min="0.3" 
                        max="0.7" 
                        step="0.05"
                        value={currentBias}
                        onChange={handleBiasChange}
                        className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                </div>

                <button 
                    onClick={handleRemoveCurve}
                    className="w-full py-1.5 px-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs rounded transition-colors border border-red-500/20"
                >
                    Remove Curve
                </button>
            </div>
        </div>
    );
}

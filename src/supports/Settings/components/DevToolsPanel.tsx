"use client";

import React, { useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { Card, Button } from '@/components/ui/primitives';
import { getSettingsSnapshot, subscribeToSettings, updateDevToolsSettings } from '../state';
import { createDefaultSettings } from '../types';

export function DevToolsPanel() {
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const { devTools } = settings;

    // Collapsible sections state
    const [solverOpen, setSolverOpen] = useState(true);
    const [trunkOpen, setTrunkOpen] = useState(true);
    const [rescueOpen, setRescueOpen] = useState(true);
    const [consolidationOpen, setConsolidationOpen] = useState(true);

    const handleResetTrunk = () => {
        const defaultDev = createDefaultSettings().devTools;
        updateDevToolsSettings({
            clearanceMm: defaultDev.clearanceMm,
            marginMm: defaultDev.marginMm,
            repulsionStrength: defaultDev.repulsionStrength,
            stepMm: defaultDev.stepMm,
            maxLateralMm: defaultDev.maxLateralMm,
            tangentWeight: defaultDev.tangentWeight,
        });
    };

    const handleResetRescue = () => {
        const defaultDev = createDefaultSettings().devTools;
        updateDevToolsSettings({
            maxNearestNodeSearchRings: defaultDev.maxNearestNodeSearchRings,
            coneStretchLinearWeight: defaultDev.coneStretchLinearWeight,
            coneStretchQuadraticWeight: defaultDev.coneStretchQuadraticWeight,
            coneAngleWeight: defaultDev.coneAngleWeight,
            maxConeStretchRatio: defaultDev.maxConeStretchRatio,
        });
    };

    const handleResetConsolidation = () => {
        const defaultDev = createDefaultSettings().devTools;
        updateDevToolsSettings({
            maxVerticalAttachmentDistanceMm: defaultDev.maxVerticalAttachmentDistanceMm,
            maxHorizontalAttachmentDistanceMm: defaultDev.maxHorizontalAttachmentDistanceMm,
            minHorizontalLeafAngleDeg: defaultDev.minHorizontalLeafAngleDeg,
            maxLeafStretchFactor: defaultDev.maxLeafStretchFactor,
            maxConeAngleDevDeg: defaultDev.maxConeAngleDevDeg,
            verticalKnotSpacingMm: defaultDev.verticalKnotSpacingMm,
            maxBranchesPerTrunk: defaultDev.maxBranchesPerTrunk,
        });
    };

    const renderSlider = (
        label: string,
        key: keyof typeof devTools,
        min: number,
        max: number,
        step: number,
        unit = ''
    ) => {
        const val = devTools[key] as number;
        return (
            <div className="space-y-1">
                <div className="flex justify-between items-center text-[10px] text-neutral-400">
                    <span>{label}</span>
                    <span className="font-semibold text-neutral-200">
                        {val.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2)}{unit}
                    </span>
                </div>
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={val}
                    onChange={(e) => updateDevToolsSettings({ [key]: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
            </div>
        );
    };

    return (
        <Card className="w-80 max-h-[calc(100dvh-var(--topbar-height)-24px)] overflow-y-auto custom-scrollbar p-3 flex flex-col gap-3 border-neutral-700 bg-neutral-800 shadow-2xl">
            <div className="flex justify-between items-center pb-2 border-b border-neutral-700">
                <h3 className="text-sm font-bold text-neutral-100">Dev Support Tools</h3>
                <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-mono uppercase tracking-wide">
                    Tuning Active
                </span>
            </div>

            {/* SECTION: Solver Selection */}
            <div className="space-y-2">
                <button
                    onClick={() => setSolverOpen(!solverOpen)}
                    className="w-full flex justify-between items-center text-xs font-semibold text-neutral-300 hover:text-white"
                >
                    <span>1. Solver Mode</span>
                    {solverOpen ? <ChevronDown className="h-4.5 w-4.5" /> : <ChevronRight className="h-4.5 w-4.5" />}
                </button>
                {solverOpen && (
                    <div className="bg-neutral-750 p-2 rounded space-y-3.5">
                        <div className="space-y-1.5">
                            <span className="text-[10px] text-neutral-400">Routing Algorithm</span>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    onClick={() => updateDevToolsSettings({ routingAlgorithm: 'astar' })}
                                    className={`px-2 py-1 text-xs font-semibold rounded border transition-colors ${
                                        devTools.routingAlgorithm === 'astar'
                                            ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                                            : 'border-neutral-600 bg-neutral-700 text-neutral-300 hover:border-neutral-500'
                                    }`}
                                >
                                    A* Grid
                                </button>
                                <button
                                    onClick={() => updateDevToolsSettings({ routingAlgorithm: 'potential' })}
                                    className={`px-2 py-1 text-xs font-semibold rounded border transition-colors ${
                                        devTools.routingAlgorithm === 'potential'
                                            ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                                            : 'border-neutral-600 bg-neutral-700 text-neutral-300 hover:border-neutral-500'
                                    }`}
                                >
                                    Potential Field
                                </button>
                            </div>
                        </div>

                        <div className="flex justify-between items-center pt-1">
                            <span className="text-[10px] text-neutral-400">Deterministic Field Solver</span>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={devTools.fieldDeterministic}
                                    onChange={(e) => updateDevToolsSettings({ fieldDeterministic: e.target.checked })}
                                    className="sr-only peer"
                                />
                                <div className="w-9 h-5 bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-neutral-300 after:border-neutral-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600 peer-checked:after:bg-white"></div>
                            </label>
                        </div>
                    </div>
                )}
            </div>

            {/* SECTION: Trunk Placement Weights */}
            <div className="space-y-2">
                <button
                    onClick={() => setTrunkOpen(!trunkOpen)}
                    className="w-full flex justify-between items-center text-xs font-semibold text-neutral-300 hover:text-white"
                >
                    <span>2. Trunk Placement Sliders</span>
                    {trunkOpen ? <ChevronDown className="h-4.5 w-4.5" /> : <ChevronRight className="h-4.5 w-4.5" />}
                </button>
                {trunkOpen && (
                    <div className="bg-neutral-750 p-2 rounded space-y-3">
                        {renderSlider('Min Clearance', 'clearanceMm', 0.1, 3.0, 0.05, 'mm')}
                        {renderSlider('Safety Margin', 'marginMm', 0.1, 5.0, 0.1, 'mm')}
                        {renderSlider('Repulsion Strength', 'repulsionStrength', 0.5, 25.0, 0.5)}
                        {renderSlider('Solver Step Size', 'stepMm', 0.1, 2.5, 0.1, 'mm')}
                        {renderSlider('Max Lateral Deviation', 'maxLateralMm', 5, 100, 1, 'mm')}
                        {renderSlider('Tangent Swirl Weight', 'tangentWeight', 0.0, 3.0, 0.1)}
                        <Button
                            type="button"
                            onClick={handleResetTrunk}
                            className="w-full flex justify-center items-center gap-1.5 py-1 text-[10px] border border-neutral-600 bg-neutral-700 text-neutral-300 hover:bg-neutral-650"
                        >
                            <RotateCcw className="h-3 w-3" />
                            Reset Trunk Weights
                        </Button>
                    </div>
                )}
            </div>

            {/* SECTION: Rescue Weights */}
            <div className="space-y-2">
                <button
                    onClick={() => setRescueOpen(!rescueOpen)}
                    className="w-full flex justify-between items-center text-xs font-semibold text-neutral-300 hover:text-white"
                >
                    <span>3. Rescue & Overhang Weights</span>
                    {rescueOpen ? <ChevronDown className="h-4.5 w-4.5" /> : <ChevronRight className="h-4.5 w-4.5" />}
                </button>
                {rescueOpen && (
                    <div className="bg-neutral-750 p-2 rounded space-y-3">
                        {renderSlider('Max Search Rings', 'maxNearestNodeSearchRings', 1, 24, 1)}
                        {renderSlider('Cone Stretch Linear Wt', 'coneStretchLinearWeight', 0.1, 20.0, 0.5)}
                        {renderSlider('Cone Stretch Quadratic Wt', 'coneStretchQuadraticWeight', 0.1, 15.0, 0.5)}
                        {renderSlider('Cone Angle Weight', 'coneAngleWeight', 0.01, 0.5, 0.01)}
                        {renderSlider('Max Cone Stretch Ratio', 'maxConeStretchRatio', 0.1, 1.5, 0.05)}
                        <Button
                            type="button"
                            onClick={handleResetRescue}
                            className="w-full flex justify-center items-center gap-1.5 py-1 text-[10px] border border-neutral-600 bg-neutral-700 text-neutral-300 hover:bg-neutral-650"
                        >
                            <RotateCcw className="h-3 w-3" />
                            Reset Rescue Weights
                        </Button>
                    </div>
                )}
            </div>

            {/* SECTION: Consolidation Metrics */}
            <div className="space-y-2">
                <button
                    onClick={() => setConsolidationOpen(!consolidationOpen)}
                    className="w-full flex justify-between items-center text-xs font-semibold text-neutral-300 hover:text-white"
                >
                    <span>4. Consolidation Metrics</span>
                    {consolidationOpen ? <ChevronDown className="h-4.5 w-4.5" /> : <ChevronRight className="h-4.5 w-4.5" />}
                </button>
                {consolidationOpen && (
                    <div className="bg-neutral-750 p-2 rounded space-y-3">
                        {renderSlider('Max Vert Attach Distance', 'maxVerticalAttachmentDistanceMm', 5.0, 100.0, 1.0, 'mm')}
                        {renderSlider('Max Horiz Attach Distance', 'maxHorizontalAttachmentDistanceMm', 2.0, 50.0, 1.0, 'mm')}
                        {renderSlider('Min Horiz Leaf Angle', 'minHorizontalLeafAngleDeg', 0.0, 90.0, 5.0, '°')}
                        {renderSlider('Max Leaf Stretch Factor', 'maxLeafStretchFactor', 1.0, 4.0, 0.1, 'x')}
                        {renderSlider('Max Cone Angle Deviation', 'maxConeAngleDevDeg', 5.0, 90.0, 5.0, '°')}
                        {renderSlider('Min Vert Knot Spacing', 'verticalKnotSpacingMm', 0.5, 10.0, 0.5, 'mm')}
                        {renderSlider('Max Branches per Trunk', 'maxBranchesPerTrunk', 1, 10, 1)}
                        <Button
                            type="button"
                            onClick={handleResetConsolidation}
                            className="w-full flex justify-center items-center gap-1.5 py-1 text-[10px] border border-neutral-600 bg-neutral-700 text-neutral-300 hover:bg-neutral-650"
                        >
                            <RotateCcw className="h-3 w-3" />
                            Reset Consolidation Defaults
                        </Button>
                    </div>
                )}
            </div>
        </Card>
    );
}

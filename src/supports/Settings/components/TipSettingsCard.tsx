"use client";

import React from 'react';
import { TipProfile } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';

interface TipSettingsCardProps {
    tip: TipProfile;
    onChange: (tip: Partial<TipProfile>) => void;
}

export function TipSettingsCard({ tip, onChange }: TipSettingsCardProps) {
    return (
        <div className="bg-neutral-750 rounded p-1 mb-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-neutral-300">Tip</span>
                <span className="text-[9px] text-neutral-500 uppercase tracking-wide">{tip.shape}</span>
            </div>
            
            {/* Contact Type Selector */}
            <div className="mb-1.5">
                <select
                    value={tip.type || 'disk'}
                    onChange={(e) => onChange({ type: e.target.value as any })}
                    className="w-full px-1.5 py-1 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                >
                    <option value="disk">Contact Disk</option>
                    {/* <option value="sphere">Contact Sphere</option> */}
                </select>
            </div>

            <div className="mb-1.5">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-[9px] text-neutral-400">Cone Angle Mode</span>
                    <span className="text-[9px] text-neutral-500 uppercase tracking-wide">{tip.coneAngleMode ?? 'normal'}</span>
                </div>
                <select
                    value={tip.coneAngleMode ?? 'normal'}
                    onChange={(e) => onChange({ coneAngleMode: e.target.value as any })}
                    className="w-full px-1.5 py-1 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                >
                    <option value="normal">Normal</option>
                    <option value="locked">Locked</option>
                    <option value="adaptive">Adaptive</option>
                </select>
            </div>

            {(tip.coneAngleMode ?? 'normal') === 'adaptive' && (
                <div className="mb-1.5">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] text-neutral-400">Adaptive Offset (deg)</span>
                        <span className="text-[9px] text-neutral-500 uppercase tracking-wide">+{tip.adaptiveConeAngleOffsetDeg ?? 30}</span>
                    </div>
                    <NumberInput
                        value={tip.adaptiveConeAngleOffsetDeg ?? 30}
                        onChange={(val) => {
                            let safeVal = val;
                            if (safeVal < 0) safeVal = 0;
                            if (safeVal > 90) safeVal = 90;
                            onChange({ adaptiveConeAngleOffsetDeg: safeVal });
                        }}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </div>
            )}

            <div className="grid grid-cols-3 gap-1.5">
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Contact</span>
                    <NumberInput
                        value={tip.contactDiameterMm}
                        onChange={(val) => onChange({ contactDiameterMm: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Body</span>
                    <NumberInput
                        value={tip.bodyDiameterMm}
                        onChange={(val) => onChange({ bodyDiameterMm: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Length</span>
                    <NumberInput
                        value={tip.lengthMm}
                        onChange={(val) => onChange({ lengthMm: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
            </div>
        </div>
    );
}

"use client";

import React from 'react';
import { ShaftProfile } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';

interface ShaftSettingsCardProps {
    shaft: ShaftProfile;
    onChange: (shaft: Partial<ShaftProfile>) => void;
}

export function ShaftSettingsCard({ shaft, onChange }: ShaftSettingsCardProps) {
    return (
        <div className="bg-neutral-750 rounded p-1 mb-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-neutral-300">Shaft</span>
                <span className="text-[9px] text-neutral-500 uppercase tracking-wide">{shaft.shape}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 mb-1.5">
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Diameter</span>
                    <NumberInput
                        value={shaft.diameterMm}
                        onChange={(val) => onChange({ diameterMm: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Max Angle</span>
                    <NumberInput
                        value={shaft.maxAngleDeg ?? 80}
                        onChange={(val) => onChange({ maxAngleDeg: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
            </div>
        </div>
    );
}

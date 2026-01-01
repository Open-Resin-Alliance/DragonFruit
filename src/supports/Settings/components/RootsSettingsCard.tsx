"use client";

import React from 'react';
import { RootsProfile } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';

interface RootsSettingsCardProps {
    roots: RootsProfile;
    onChange: (roots: Partial<RootsProfile>) => void;
}

export function RootsSettingsCard({ roots, onChange }: RootsSettingsCardProps) {
    return (
        <div className="bg-neutral-750 rounded p-1 mb-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-neutral-300">Roots</span>
                <span className="text-[9px] text-neutral-500 uppercase tracking-wide">{roots.shape}</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Diameter</span>
                    <NumberInput
                        value={roots.diameterMm}
                        onChange={(val) => onChange({ diameterMm: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Disk H</span>
                    <NumberInput
                        value={roots.diskHeightMm}
                        onChange={(val) => onChange({ diskHeightMm: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-neutral-400">Cone H</span>
                    <NumberInput
                        value={roots.coneHeightMm}
                        onChange={(val) => onChange({ coneHeightMm: val })}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                    />
                </label>
            </div>
        </div>
    );
}

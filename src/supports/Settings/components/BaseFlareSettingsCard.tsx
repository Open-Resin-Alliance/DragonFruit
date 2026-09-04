"use client";

import React from 'react';
import { BaseFlareProfile } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';

interface BaseFlareSettingsCardProps {
    baseFlare: BaseFlareProfile;
    onChange: (baseFlare: Partial<BaseFlareProfile>) => void;
}

export function BaseFlareSettingsCard({ baseFlare, onChange }: BaseFlareSettingsCardProps) {
    const { _ } = useLingui();
    return (
        <div className="bg-neutral-750 rounded p-1 mb-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-neutral-300">{_(msg`Base Flare`)}</span>
                <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-[9px] text-neutral-500 uppercase tracking-wide">
                        {baseFlare.enabled ? _(msg({ message: 'on', comment: 'Lowercase on/off marker next to a small toggle in the support settings cards.' })) : _(msg({ message: 'off', comment: 'Lowercase on/off marker next to a small toggle in the support settings cards.' }))}
                    </span>
                    <input
                        type="checkbox"
                        checked={baseFlare.enabled}
                        onChange={(e) => onChange({ enabled: e.target.checked })}
                        className="w-3 h-3 rounded border-neutral-700 bg-neutral-900 text-blue-600 focus:ring-1 focus:ring-blue-500"
                    />
                </label>
            </div>
            {baseFlare.enabled && (
                <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                        <span className="text-[9px] text-neutral-400">{_(msg`Diameter`)}</span>
                        <NumberInput
                            value={baseFlare.diameterMm}
                            onChange={(val) => onChange({ diameterMm: val })}
                            className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                        />
                    </label>
                    <label className="flex flex-col gap-0.5">
                        <span className="text-[9px] text-neutral-400">{_(msg`Height`)}</span>
                        <NumberInput
                            value={baseFlare.heightMm}
                            onChange={(val) => onChange({ heightMm: val })}
                            className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                        />
                    </label>
                </div>
            )}
        </div>
    );
}

"use client";

import React from 'react';
import { TipProfile } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';

interface TipSettingsCardProps {
    tip: TipProfile;
    onChange: (tip: Partial<TipProfile>) => void;
}

import { subscribeToAnatomyPreviewState, getAnatomyPreviewState, setAnatomyPreviewActiveSettingKey } from '@/supports/Settings/AnatomyPreview/previewState';
import { useSyncExternalStore } from 'react';

export function TipSettingsCard({ tip, onChange }: TipSettingsCardProps) {
    const previewState = useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);
    const activeKey = previewState.activeSettingKey;

    const getInputClass = (key: string) => {
        const isActive = activeKey === key;
        const base = "w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border focus:outline-none no-spinners transition-colors";
        return isActive
            ? `${base} border-blue-500 ring-1 ring-blue-500/50`
            : `${base} border-neutral-600 focus:border-blue-500`;
    };

    return (
        <div className="bg-neutral-750 rounded p-1 mb-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-neutral-300">Tip</span>
                <span className="text-[11px] text-neutral-500 uppercase tracking-wide">{tip.shape}</span>
            </div>

            {/* Contact Type Selector */}
            <div className="mb-1.5">
                <SelectDropdown
                    value={tip.type || 'disk'}
                    onChange={(value) => onChange({ type: value as any })}
                    options={[{ value: 'disk', label: 'Contact Disk' }]}
                    className="space-y-0"
                    selectClassName="w-full px-1.5 py-1 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                    onFocus={() => setAnatomyPreviewActiveSettingKey('tip.type')}
                    onBlur={() => setAnatomyPreviewActiveSettingKey(null)}
                />
            </div>

            <div className="mb-1.5">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-neutral-400">Cone Angle Mode</span>
                    <span className="text-[11px] text-neutral-500 uppercase tracking-wide">{tip.coneAngleMode ?? 'normal'}</span>
                </div>
                <SelectDropdown
                    value={tip.coneAngleMode ?? 'normal'}
                    onChange={(value) => onChange({ coneAngleMode: value as any })}
                    options={[
                        { value: 'normal', label: 'Normal' },
                        { value: 'locked', label: 'Locked' },
                        { value: 'adaptive', label: 'Adaptive' },
                    ]}
                    className="space-y-0"
                    selectClassName="w-full px-1.5 py-1 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                    onFocus={() => setAnatomyPreviewActiveSettingKey('tip.coneAngleMode')}
                    onBlur={() => setAnatomyPreviewActiveSettingKey(null)}
                />
            </div>

            {(tip.coneAngleMode ?? 'normal') === 'adaptive' && (
                <div className="mb-1.5">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-neutral-400">Adaptive Offset (deg)</span>
                        <span className="text-[11px] text-neutral-500 uppercase tracking-wide">+{tip.adaptiveConeAngleOffsetDeg ?? 30}</span>
                    </div>
                    <NumberInput
                        value={tip.adaptiveConeAngleOffsetDeg ?? 30}
                        onChange={(val) => {
                            let safeVal = val;
                            if (safeVal < 0) safeVal = 0;
                            if (safeVal > 90) safeVal = 90;
                            onChange({ adaptiveConeAngleOffsetDeg: safeVal });
                        }}
                        onFocus={() => setAnatomyPreviewActiveSettingKey('tip.adaptiveConeAngleOffsetDeg')}
                        onBlur={() => setAnatomyPreviewActiveSettingKey(null)}
                        className={getInputClass('tip.adaptiveConeAngleOffsetDeg')}
                    />
                </div>
            )}

            <div className="grid grid-cols-3 gap-1.5">
                <label className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-neutral-400">Contact</span>
                    <NumberInput
                        value={tip.contactDiameterMm}
                        onChange={(val) => onChange({ contactDiameterMm: val })}
                        onFocus={() => setAnatomyPreviewActiveSettingKey('tip.contactDiameterMm')}
                        onBlur={() => setAnatomyPreviewActiveSettingKey(null)}
                        className={getInputClass('tip.contactDiameterMm')}
                    />
                </label>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-neutral-400">Body</span>
                    <NumberInput
                        value={tip.bodyDiameterMm}
                        onChange={(val) => onChange({ bodyDiameterMm: val })}
                        onFocus={() => setAnatomyPreviewActiveSettingKey('tip.bodyDiameterMm')}
                        onBlur={() => setAnatomyPreviewActiveSettingKey(null)}
                        className={getInputClass('tip.bodyDiameterMm')}
                    />
                </label>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-neutral-400">Length</span>
                    <NumberInput
                        value={tip.lengthMm}
                        onChange={(val) => onChange({ lengthMm: val })}
                        onFocus={() => setAnatomyPreviewActiveSettingKey('tip.lengthMm')}
                        onBlur={() => setAnatomyPreviewActiveSettingKey(null)}
                        className={getInputClass('tip.lengthMm')}
                    />
                </label>
            </div>
        </div>
    );
}

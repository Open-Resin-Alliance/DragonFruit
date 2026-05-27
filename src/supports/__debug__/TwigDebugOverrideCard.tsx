// TEMPORARY DEBUG UI — see twigDiameterOverride.ts for removal instructions.
"use client";

import React, { useSyncExternalStore } from 'react';
import { NumberInput } from '@/components/ui/NumberInput';
import {
    getTwigDiskBOverrideMm,
    setTwigDiskBOverrideMm,
    subscribeTwigDiskBOverride,
} from './twigDiameterOverride';

export function TwigDebugOverrideCard() {
    const override = useSyncExternalStore(subscribeTwigDiskBOverride, getTwigDiskBOverrideMm, getTwigDiskBOverrideMm);
    const enabled = override !== null;
    const editValue = override ?? 0.6;

    return (
        <div
            className="absolute left-3 top-3 z-[70] w-[260px] rounded-lg border p-3 shadow-xl"
            style={{
                pointerEvents: 'auto',
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--surface-0), black 6%)',
                color: 'var(--text-strong)',
            }}
        >
            <div className="text-xs font-semibold mb-2">Twig Disk B Diameter (debug)</div>

            <label className="flex items-center gap-2 text-[11px] mb-2">
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setTwigDiskBOverrideMm(e.target.checked ? editValue : null)}
                />
                Override disk B diameter
            </label>

            <div className="space-y-1">
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Disk B diameter (mm) — disk A still uses global tip diameter
                </div>
                <NumberInput
                    value={editValue}
                    onChange={(val) => {
                        if (enabled) setTwigDiskBOverrideMm(val);
                    }}
                    step={0.1}
                    className="ui-input h-8 w-full px-2 text-xs no-spinners"
                />
            </div>

            <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Applies to NEW twigs only. Existing twigs are unaffected.
            </div>
        </div>
    );
}

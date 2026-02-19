"use client";

import React from 'react';
import { Grid3X3, Pickaxe, Sailboat, WandSparkles, type LucideIcon } from 'lucide-react';
import type { SupportKind } from '../supportKindState';

type TabDef = {
    kind: SupportKind;
    label: string;
    icon: LucideIcon;
};

const TABS: TabDef[] = [
    { kind: 'trunk', label: 'Trunk', icon: Pickaxe },
    { kind: 'raft', label: 'Raft', icon: Sailboat },
    { kind: 'grid', label: 'Grid', icon: Grid3X3 },
    { kind: 'stick', label: 'Stick', icon: WandSparkles },
];

export function SupportKindTabs({
    value,
    onChange,
}: {
    value: SupportKind;
    onChange: (kind: SupportKind) => void;
}) {
    return (
        <div className="grid grid-cols-4 gap-1">
            {TABS.map((tab) => {
                const isActive = tab.kind === value;
                const Icon = tab.icon;

                return (
                    <button
                        key={tab.kind}
                        type="button"
                        onClick={() => onChange(tab.kind)}
                        className="flex h-12 cursor-pointer items-center justify-center gap-2 rounded-md border px-2 transition-all duration-150 hover:-translate-y-px hover:brightness-110 hover:shadow-[0_8px_18px_rgba(0,0,0,0.18)]"
                        style={isActive
                            ? {
                                background: 'color-mix(in srgb, var(--accent), var(--surface-0) 78%)',
                                borderColor: 'color-mix(in srgb, var(--accent), white 14%)',
                                color: 'var(--text-strong)',
                                boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent), transparent 74%) inset',
                            }
                            : {
                                background: 'var(--surface-1)',
                                borderColor: 'var(--border-subtle)',
                                color: 'var(--text-muted)',
                            }}
                        title={tab.label}
                    >
                        <span
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md border"
                            style={isActive
                                ? {
                                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 62%)',
                                    borderColor: 'color-mix(in srgb, var(--accent), white 18%)',
                                }
                                : {
                                    background: 'var(--surface-0)',
                                    borderColor: 'var(--border-subtle)',
                                }}
                        >
                            <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-[13px] font-semibold leading-none">{tab.label}</span>
                    </button>
                );
            })}
        </div>
    );
}

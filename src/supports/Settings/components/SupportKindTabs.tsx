"use client";

import React from 'react';
import type { SupportKind } from '../supportKindState';

type TabDef = {
    kind: SupportKind;
    label: string;
};

const TABS: TabDef[] = [
    { kind: 'trunk', label: 'Trunk' },
    { kind: 'raft', label: 'Raft' },
    { kind: 'branch', label: 'Branch' },
    { kind: 'stick', label: 'Stick' },
];

function TabIcon({ kind }: { kind: SupportKind }) {
    const common = {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
    };

    if (kind === 'trunk') {
        return (
            <svg {...common}>
                <path d="M12 4v12" />
                <path d="M8 20h8" />
                <path d="M9 16h6" />
            </svg>
        );
    }

    if (kind === 'raft') {
        return (
            <svg {...common}>
                <path d="M5 15h14" />
                <path d="M7 11h10" />
                <path d="M7 11l-2 4" />
                <path d="M17 11l2 4" />
            </svg>
        );
    }

    if (kind === 'leaf') {
        return (
            <svg {...common}>
                <path d="M18 6c-6 0-10 4-10 10" />
                <path d="M8 16c6 0 10-4 10-10" />
                <path d="M9 15l6-6" />
            </svg>
        );
    }

    if (kind === 'branch') {
        return (
            <svg {...common}>
                <path d="M12 20V10" />
                <path d="M12 10l-5-5" />
                <path d="M12 10l5-5" />
            </svg>
        );
    }

    if (kind === 'stick') {
        return (
            <svg {...common}>
                <path d="M6 18l12-12" />
                <path d="M7 7h0" />
                <path d="M17 17h0" />
                <circle cx="7" cy="17" r="2" />
                <circle cx="17" cy="7" r="2" />
            </svg>
        );
    }

    return (
        <svg {...common}>
            <path d="M7 17l10-10" />
            <circle cx="7" cy="17" r="1.5" />
            <circle cx="17" cy="7" r="1.5" />
        </svg>
    );
}

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
                return (
                    <button
                        key={tab.kind}
                        type="button"
                        onClick={() => onChange(tab.kind)}
                        className={
                            isActive
                                ? 'flex flex-col items-center justify-center aspect-square rounded bg-blue-600 text-white border border-blue-400/60 shadow-sm'
                                : 'flex flex-col items-center justify-center aspect-square rounded bg-neutral-800/80 text-neutral-300 border border-neutral-700 hover:bg-neutral-700/80 hover:text-neutral-100'
                        }
                        title={tab.label}
                    >
                        <div className="leading-none">{<TabIcon kind={tab.kind} />}</div>
                        <div className="mt-0.5 text-[9px] leading-none font-medium">{tab.label}</div>
                    </button>
                );
            })}
        </div>
    );
}

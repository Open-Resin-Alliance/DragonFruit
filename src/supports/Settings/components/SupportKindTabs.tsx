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
    { kind: 'stick', label: 'Bracing', icon: WandSparkles },
];

export function SupportKindTabs({
    value,
    onChange,
}: {
    value: SupportKind;
    onChange: (kind: SupportKind) => void;
}) {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const [showIcons, setShowIcons] = React.useState(true);

    React.useEffect(() => {
        const element = containerRef.current;
        if (!element) return;

        const TAB_COUNT = TABS.length;
        const GAP_PX = 4; // Tailwind gap-1
        const MIN_TAB_WIDTH_FOR_ICON = 84;

        const recompute = () => {
            const containerWidth = element.getBoundingClientRect().width;
            if (!Number.isFinite(containerWidth) || containerWidth <= 0) return;
            const totalGap = GAP_PX * (TAB_COUNT - 1);
            const tabWidth = (containerWidth - totalGap) / TAB_COUNT;
            const next = tabWidth >= MIN_TAB_WIDTH_FOR_ICON;
            setShowIcons((prev) => (prev === next ? prev : next));
        };

        const rafA = window.requestAnimationFrame(recompute);
        const rafB = window.requestAnimationFrame(() => {
            window.requestAnimationFrame(recompute);
        });
        const timeoutId = window.setTimeout(recompute, 60);

        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
                recompute();
            });
            observer.observe(element);
        }

        window.addEventListener('resize', recompute);
        recompute();

        return () => {
            window.cancelAnimationFrame(rafA);
            window.cancelAnimationFrame(rafB);
            window.clearTimeout(timeoutId);
            window.removeEventListener('resize', recompute);
            observer?.disconnect();
        };
    }, []);

    return (
        <div ref={containerRef} className="grid grid-cols-4 gap-1">
            {TABS.map((tab) => {
                const isActive = tab.kind === value;
                const Icon = tab.icon;

                return (
                    <button
                        key={tab.kind}
                        type="button"
                        onClick={() => onChange(tab.kind)}
                        className={`flex h-12 cursor-pointer items-center justify-center rounded-md border px-2 transition-all duration-150 hover:-translate-y-px hover:brightness-110 hover:shadow-[0_8px_18px_rgba(0,0,0,0.18)] ${showIcons ? 'gap-2' : 'gap-0'}`}
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
                        {showIcons && <Icon className="h-4 w-4 shrink-0" />}
                        <span className="text-[13px] font-semibold leading-none">{tab.label}</span>
                    </button>
                );
            })}
        </div>
    );
}

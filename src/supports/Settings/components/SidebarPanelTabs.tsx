"use client";

import React from 'react';
import { Grid3X3, Pickaxe, Sailboat, WandSparkles, type LucideIcon } from 'lucide-react';
import type { SidebarTab } from '../sidebarPanels';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type TabDef = {
    tab: SidebarTab;
    label: MessageDescriptor;
    icon: LucideIcon;
};

// Module level so React Compiler cannot rename anything the Lingui macro reads.
// Each id names the PAGE it opens, not a support type: `supportInfo` carries the
// contact cone, cone angle and root settings that apply to supports generally.
const TABS: TabDef[] = [
    { tab: 'supportInfo', label: msg({ message: 'General', comment: 'Support kind tab. One of four tabs on a narrow row, so keep it to one short word.' }), icon: Pickaxe },
    { tab: 'raft', label: msg({ message: 'Raft', comment: 'Support kind tab. One of four tabs on a narrow row, so keep it to one short word.' }), icon: Sailboat },
    { tab: 'grid', label: msg({ message: 'Grid', comment: 'Support kind tab. One of four tabs on a narrow row, so keep it to one short word.' }), icon: Grid3X3 },
    { tab: 'bracing', label: msg({ message: 'Bracing', comment: 'Support kind tab. One of four tabs on a narrow row, so keep it to one short word.' }), icon: WandSparkles },
];

export function SidebarPanelTabs({
    value,
    onChange,
}: {
    /** `'auto'` is the auto panel's tab, which no tab in this row opens. */
    value: SidebarTab | 'auto';
    onChange: (tab: SidebarTab) => void;
}) {
    const { _ } = useLingui();
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
                const isActive = tab.tab === value;
                const Icon = tab.icon;

                return (
                    <button
                        key={tab.tab}
                        type="button"
                        onClick={() => onChange(tab.tab)}
                        className={`flex h-12 cursor-pointer items-center justify-center rounded-md border px-2 transition-all duration-150 hover:brightness-110 hover:shadow-[0_8px_18px_rgba(0,0,0,0.18)] ${showIcons ? 'gap-2' : 'gap-0'}`}
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
                        title={_(tab.label)}
                    >
                        {showIcons && <Icon className="h-4 w-4 shrink-0" />}
                        <span className="text-[13px] font-semibold leading-none">{_(tab.label)}</span>
                    </button>
                );
            })}
        </div>
    );
}

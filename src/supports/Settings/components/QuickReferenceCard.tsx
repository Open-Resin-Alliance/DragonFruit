"use client";

import React, { useState } from 'react';
import { Keyboard, ChevronDown, ChevronUp } from 'lucide-react';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';

export function QuickReferenceCard() {
    const [isOpen, setIsOpen] = useState(false);
    const { config } = useHotkeyConfig();

    const supportHotkeys = config.SUPPORTS || {};

    const formatHotkey = (key: string, modifier?: string) => {
        const parts = [];
        if (modifier) {
            // e.g. ctrl+shift -> Ctrl + Shift
            parts.push(...modifier.split('+').map(m => m.charAt(0).toUpperCase() + m.slice(1)));
        }
        parts.push(key.charAt(0).toUpperCase() + key.slice(1));
        return parts.join(' + ');
    };

    return (
        <div 
            className="rounded-lg border shadow-lg overflow-hidden mb-3 backdrop-blur-md"
            style={{ 
                borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 40%)', 
                background: 'color-mix(in srgb, var(--surface-1), transparent 30%)' 
            }}
        >
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold hover:bg-white/5 transition-colors focus:outline-none"
                style={{ color: 'var(--text-strong)' }}
            >
                <div className="flex items-center gap-2">
                    <Keyboard className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                    <span>Support Controls Reference</span>
                </div>
                {isOpen ? (
                    <ChevronUp className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                ) : (
                    <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                )}
            </button>

            {isOpen && (
                <div 
                    className="px-3 pb-3 pt-1 border-t text-[11px] space-y-2"
                    style={{ 
                        borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 50%)',
                        color: 'var(--text-muted)' 
                    }}
                >
                    <div 
                        className="grid grid-cols-12 gap-1 font-semibold border-b pb-1.5 mb-1.5"
                        style={{ borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 60%)' }}
                    >
                        <div className="col-span-5">Hotkey</div>
                        <div className="col-span-7">Description</div>
                    </div>
                    <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                        {Object.entries(supportHotkeys).map(([actionName, binding]) => (
                            <div key={actionName} className="grid grid-cols-12 gap-1 items-start py-0.5">
                                <div className="col-span-5 flex items-center">
                                    <kbd 
                                        className="px-1.5 py-0.5 rounded font-mono text-[9px] border"
                                        style={{ 
                                            background: 'var(--surface-2)',
                                            borderColor: 'var(--border-subtle)',
                                            color: 'var(--text-strong)'
                                        }}
                                    >
                                        {formatHotkey(binding.key, binding.modifier)}
                                    </kbd>
                                </div>
                                <div className="col-span-7 leading-normal" style={{ color: 'var(--text-muted)' }}>
                                    {binding.description}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

"use client";

import React, { useState, useRef, useEffect } from 'react';
import { SupportPreset } from '../types';
import { setAnatomyPreviewActiveSettingKey, setAnatomyPreviewActiveSettingValue } from '../AnatomyPreview/previewState';

interface PresetCardProps {
    preset: SupportPreset;
    isActive: boolean;
    onClick: () => void;
    onSave: () => void;
    onRename: (newName: string) => void;
}

export function PresetCard({ preset, isActive, onClick, onSave, onRename }: PresetCardProps) {
    const [isRenaming, setIsRenaming] = useState(false);
    const [tempName, setTempName] = useState(preset.name);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus();
            // Place cursor at the end
            const len = inputRef.current.value.length;
            inputRef.current.setSelectionRange(len, len);
        }
    }, [isRenaming]);

    // Update temp name if preset name changes externally
    useEffect(() => {
        if (!isRenaming) {
            setTempName(preset.name);
        }
    }, [preset.name, isRenaming]);

    const handleSaveName = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (tempName.trim()) {
            onRename(tempName.trim());
        } else {
            setTempName(preset.name); // Revert if empty
        }
        setIsRenaming(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSaveName();
        } else if (e.key === 'Escape') {
            setTempName(preset.name);
            setIsRenaming(false);
        }
    };

    return (
        <div
            className="relative group flex flex-col justify-center gap-1.5 px-3 py-2.5 rounded-md border transition-all duration-150 cursor-pointer min-h-[60px]"
            style={isActive
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 16%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 85%)',
                }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                }}
            onClick={onClick}
        >
            {/* Save Button (Absolute positioned to be close to edge) */}
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onSave();
                }}
                title="Save current settings to this preset"
                className="absolute top-1 right-1 w-5.5 h-5.5 flex items-center justify-center rounded transition-all opacity-0 group-hover:opacity-100 z-10"
                style={{ color: 'var(--text-muted)' }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v13a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                </svg>
            </button>

            {/* Name / Rename Input */}
            <div className="w-full h-[22px] flex items-center justify-center px-4" onDoubleClick={() => setIsRenaming(true)}>
                {isRenaming ? (
                    <input
                        ref={inputRef}
                        type="text"
                        value={tempName}
                        onChange={(e) => setTempName(e.target.value)}
                        onBlur={() => handleSaveName()}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => e.stopPropagation()} // Prevent card click
                        className="w-full ui-input rounded px-1 text-sm text-center focus:outline-none h-full"
                    />
                ) : (
                    <div className="w-full font-semibold text-[1.05rem] truncate select-none text-center" style={{ color: 'var(--text-strong)' }}>
                        {preset.name}
                    </div>
                )}
            </div>

            {/* Stats: Diameter | Length | Trunk */}
            {/* Stats: Diameter | Length | Trunk */}
            {/* Stats: Diameter | Length | Trunk */}
            <div className="w-full flex items-center gap-0 text-[11px] font-mono leading-none px-0.5" style={{ color: 'var(--text-muted)' }}>
                <div
                    title="Contact Diameter"
                    className="flex-1 flex justify-center items-center gap-px whitespace-nowrap w-0 transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={() => {
                        setAnatomyPreviewActiveSettingKey('tip.contactDiameterMm');
                        setAnatomyPreviewActiveSettingValue(preset.settings.tip.contactDiameterMm);
                    }}
                    onMouseLeave={() => {
                        setAnatomyPreviewActiveSettingKey(null);
                        setAnatomyPreviewActiveSettingValue(null);
                    }}
                >
                    <span style={{ color: 'color-mix(in srgb, var(--text-muted), white 12%)' }}>⌀</span>
                    <span>{preset.settings.tip.contactDiameterMm}</span>
                </div>
                <div className="w-px h-2.5 flex-shrink-0" style={{ background: 'var(--border-subtle)' }} />
                <div
                    title="Contact Cone Length"
                    className="flex-1 flex justify-center items-center gap-px whitespace-nowrap w-0 transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={() => {
                        setAnatomyPreviewActiveSettingKey('tip.lengthMm');
                        setAnatomyPreviewActiveSettingValue(preset.settings.tip.lengthMm);
                    }}
                    onMouseLeave={() => {
                        setAnatomyPreviewActiveSettingKey(null);
                        setAnatomyPreviewActiveSettingValue(null);
                    }}
                >
                    <span style={{ color: 'color-mix(in srgb, var(--text-muted), white 12%)' }}>L</span>
                    <span>{preset.settings.tip.lengthMm}</span>
                </div>
                <div className="w-px h-2.5 flex-shrink-0" style={{ background: 'var(--border-subtle)' }} />
                <div
                    title="Trunk Diameter"
                    className="flex-1 flex justify-center items-center gap-px whitespace-nowrap w-0 transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={() => {
                        setAnatomyPreviewActiveSettingKey('shaft.diameterMm');
                        setAnatomyPreviewActiveSettingValue(preset.settings.shaft.diameterMm);
                    }}
                    onMouseLeave={() => {
                        setAnatomyPreviewActiveSettingKey(null);
                        setAnatomyPreviewActiveSettingValue(null);
                    }}
                >
                    <span style={{ color: 'color-mix(in srgb, var(--text-muted), white 12%)' }}>T</span>
                    <span>{preset.settings.shaft.diameterMm}</span>
                </div>
            </div>

            {/* Hotkey badge (Absolute positioned or integrated? Previous was inline, let's keep it clean or minimal. 
                User didn't explicitly ask to remove it, but specific layout requested "Label... then values below". 
                I'll put hotkey absolute top-left or integrated if space permits. 
                Existing design had it on left. I'll put it absolute top right? Or maybe exclude if not critical. 
                Actually, let's just leave it out for cleaner look unless space permits in the generic view.
                Wait, user said "I want a label, then the Contact Diameter... below".
                I will skip hotkey for now to keep it clean, as it wasn't requested in the new spec and might clutter the 2-col grid.
             */}
        </div>
    );
}

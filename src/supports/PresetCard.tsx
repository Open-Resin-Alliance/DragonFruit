"use client";

import React from 'react';
import { SupportPreset } from './types';

interface PresetCardProps {
  preset: SupportPreset;
  isActive: boolean;
  onClick: () => void;
  onEdit?: () => void;
}

export function PresetCard({ preset, isActive, onClick, onEdit }: PresetCardProps) {
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.();
  };

  return (
    <button
      onClick={onClick}
      className={`
        relative w-full px-2 py-1.5 rounded border transition-all duration-150
        ${isActive 
          ? 'border-blue-500 bg-blue-500/10' 
          : 'border-neutral-700 bg-neutral-800/30 hover:border-neutral-600 hover:bg-neutral-800/50'
        }
      `}
    >
      <div className="flex items-center gap-2">
        {/* Hotkey badge */}
        {preset.hotkey && (
          <span className="text-[9px] text-neutral-500 font-mono bg-neutral-900/50 px-1 py-0.5 rounded min-w-[14px] text-center">
            {preset.hotkey}
          </span>
        )}
        
        {/* Icon */}
        <div className="text-base">{preset.icon || '📌'}</div>
        
        {/* Name */}
        <div className="flex-1 text-left min-w-0">
          <span className="font-medium text-xs text-neutral-100 truncate">
            {preset.name}
          </span>
        </div>
        
        {/* Quick stats */}
        <div className="flex items-center gap-1 text-[9px] text-neutral-500 font-mono">
          <span className="w-[22px] text-right">{preset.settings.tip.contactDiameterMm}</span>
          <span className="text-neutral-700">|</span>
          <span className="w-[22px] text-right">{preset.settings.mid.diameterMm}</span>
          <span className="text-neutral-700">|</span>
          <span className="w-[22px] text-right">{preset.settings.base.diameterMm}</span>
        </div>
        
        {/* Edit button */}
        {onEdit && (
          <button
            onClick={handleEditClick}
            className="p-1 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/50 rounded transition-colors"
            title="Edit preset"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
        )}
      </div>
    </button>
  );
}

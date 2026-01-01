import React from 'react';
import type { TransformMode } from '@/hooks/useModelTransform';

interface TransformToolbarProps {
  mode: TransformMode;
  onModeChange: (mode: TransformMode) => void;
}

export function TransformToolbar({ mode, onModeChange }: TransformToolbarProps) {
  const buttons: Array<{ mode: TransformMode; label: string; icon: string }> = [
    { mode: 'select', label: 'Select', icon: '👆' },
    { mode: 'transform', label: 'Modify', icon: '⬙' },
  ];

  return (
    <div className="absolute top-1 left-1/2 -translate-x-1/2 z-10 flex flex-row gap-2 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-1.5 shadow-xl border border-neutral-700/50">
      {buttons.map((btn) => (
        <button
          key={btn.mode}
          onClick={() => onModeChange(btn.mode)}
          className={`
            w-14 h-14 flex flex-col items-center justify-center gap-0.5 rounded-md
            transition-all duration-200
            ${
              mode === btn.mode
                ? 'bg-blue-500 text-white shadow-md'
                : 'bg-neutral-700/50 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
            }
          `}
          title={btn.label}
        >
          <span className="text-xl">{btn.icon}</span>
          <span className="text-[9px] font-medium uppercase tracking-wide">{btn.label}</span>
        </button>
      ))}
    </div>
  );
}

import React from 'react';
import type { TransformMode } from '@/hooks/useModelTransform';

interface TransformToolbarProps {
  mode: TransformMode;
  onModeChange: (mode: TransformMode) => void;
}

export function TransformToolbar({ mode, onModeChange }: TransformToolbarProps) {
  const buttons: Array<{ mode: TransformMode; label: string; icon: string }> = [
    { mode: 'select', label: 'Select', icon: '👆' },
    { mode: 'transform', label: 'Transform', icon: '⬙' },
  ];

  return (
    <div className="absolute left-4 top-20 z-10 flex flex-col gap-1 bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg">
      {buttons.map((btn) => (
        <button
          key={btn.mode}
          onClick={() => onModeChange(btn.mode)}
          className={`
            w-16 h-16 flex flex-col items-center justify-center gap-1 rounded-lg
            transition-all duration-200
            ${
              mode === btn.mode
                ? 'bg-blue-500 text-white shadow-md'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }
          `}
          title={btn.label}
        >
          <span className="text-2xl">{btn.icon}</span>
          <span className="text-[10px] font-medium">{btn.label}</span>
        </button>
      ))}
    </div>
  );
}

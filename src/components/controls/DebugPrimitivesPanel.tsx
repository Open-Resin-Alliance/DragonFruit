'use client';

import React from 'react';
import { Box, Trash2 } from 'lucide-react';

export type DebugPrimitiveType =
  | 'pillar'
  | 'merge_y'
  | 'split_y'
  | 'earlobe'
  | 'bridge'
  | 'finger_palm_arm';

export type DebugPrimitiveSizePreset = 'small' | 'medium' | 'large';

interface DebugPrimitivesPanelProps {
  onAdd: (type: DebugPrimitiveType, size: DebugPrimitiveSizePreset) => void;
  onClear: () => void;
}

function PrimitiveIcon({ type }: { type: DebugPrimitiveType }) {
  const base = 'w-7 h-7 text-neutral-200';

  if (type === 'pillar') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="4" width="6" height="16" rx="2" />
      </svg>
    );
  }

  if (type === 'merge_y') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 18 L12 12 L18 18" />
        <path d="M12 12 L12 4" />
      </svg>
    );
  }

  if (type === 'split_y') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20 L12 12" />
        <path d="M12 12 L6 6" />
        <path d="M12 12 L18 6" />
      </svg>
    );
  }

  if (type === 'earlobe') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="11" r="5" />
        <circle cx="16.5" cy="14" r="2.5" />
      </svg>
    );
  }

  if (type === 'bridge') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="9" width="7" height="10" rx="1" />
        <rect x="14" y="9" width="7" height="10" rx="1" />
        <path d="M10 12 H14" />
      </svg>
    );
  }

  // finger_palm_arm
  return (
    <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 18 V12" />
      <path d="M10 18 V11" />
      <path d="M14 18 V12" />
      <rect x="5" y="9" width="10" height="3" rx="1" />
      <path d="M18 20 V7" />
    </svg>
  );
}

export function DebugPrimitivesPanel({ onAdd, onClear }: DebugPrimitivesPanelProps) {
  const [expanded, setExpanded] = React.useState(true);
  const [sizePreset, setSizePreset] = React.useState<DebugPrimitiveSizePreset>('medium');

  const buttons: Array<{ type: DebugPrimitiveType; label: string }> = [
    { type: 'pillar', label: 'Pillar' },
    { type: 'merge_y', label: 'Merge Y' },
    { type: 'split_y', label: 'Split Y' },
    { type: 'earlobe', label: 'Earlobe' },
    { type: 'bridge', label: 'Bridge' },
    { type: 'finger_palm_arm', label: 'Finger → Palm → Arm' }
  ];

  return (
    <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl">
      <div className="flex items-center justify-between py-1 border-b border-neutral-700 mb-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
            title={expanded ? 'Collapse card' : 'Expand card'}
          >
            <svg
              className={`w-3 h-3 ${expanded ? 'text-blue-500' : 'text-neutral-500'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <div className="flex items-center gap-1.5">
            <div className="p-1 rounded bg-neutral-700 text-neutral-400">
              <Box className="w-3 h-3" />
            </div>
            <h3 className="text-xs font-semibold text-neutral-200">Debug Primitives</h3>
          </div>
        </div>

        <button
          onClick={onClear}
          className="p-1 rounded hover:bg-red-900/50 text-neutral-500 hover:text-red-400 transition-colors"
          title="Clear Debug Models"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] text-neutral-400">Size</div>
            <div className="flex items-center gap-1">
              {(['small', 'medium', 'large'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSizePreset(s)}
                  className={`px-2 py-1 rounded-md text-[10px] border transition-colors ${
                    sizePreset === s
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {buttons.map((b) => (
              <button
                key={b.type}
                onClick={() => onAdd(b.type, sizePreset)}
                className="h-16 rounded-md border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors flex flex-col items-center justify-center gap-1"
                title={`Add ${b.label}`}
              >
                <div className="w-9 h-9 rounded-md bg-neutral-900/60 border border-neutral-700/60 flex items-center justify-center">
                  <PrimitiveIcon type={b.type} />
                </div>
                <div className="text-[9px] text-neutral-200 text-center leading-tight px-1">
                  {b.label}
                </div>
              </button>
            ))}
          </div>

          <div className="text-[9px] text-neutral-500 leading-snug">
            Creates normal scene models (movable, hideable, deletable).
          </div>
        </div>
      )}
    </div>
  );
}

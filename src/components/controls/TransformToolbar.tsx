import React from 'react';
import { Hand, Move3D, Paintbrush2 } from 'lucide-react';
import type { TransformMode } from '@/hooks/useModelTransform';

interface TransformToolbarProps {
  mode: TransformMode;
  onModeChange: (mode: TransformMode) => void;
}

export function TransformToolbar({ mode, onModeChange }: TransformToolbarProps) {
  const [hoveredMode, setHoveredMode] = React.useState<TransformMode | null>(null);

  const buttons: Array<{ mode: TransformMode; label: string; icon: React.ReactNode; hint: string }> = [
    { mode: 'select', label: 'Select', icon: <Hand className="w-4 h-4" />, hint: 'Select and inspect model' },
    { mode: 'transform', label: 'Modify', icon: <Move3D className="w-4 h-4" />, hint: 'Move, rotate, and scale' },
    { mode: 'smoothing', label: 'Smooth', icon: <Paintbrush2 className="w-4 h-4" />, hint: 'Sculpt and smooth surface' },
  ];

  const activeIndex = Math.max(0, buttons.findIndex((btn) => btn.mode === mode));

  const handleModeClick = React.useCallback((next: TransformMode) => {
    React.startTransition(() => {
      onModeChange(next);
    });
  }, [onModeChange]);

  return (
    <div
      className="fixed top-16 left-1/2 z-30 -translate-x-1/2 rounded-full pointer-events-auto"
      style={{
        padding: '2px',
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent), var(--border-subtle) 70%), var(--border-subtle), color-mix(in srgb, var(--accent), var(--border-subtle) 70%))',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.2)',
      }}
    >
      <div
        className="relative grid grid-cols-3 items-center rounded-full px-1 py-1"
        style={{
          background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 50%)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div
          className="pointer-events-none absolute left-1 top-1 bottom-1 rounded-full transition-transform duration-300 ease-out"
          style={{
            width: 'calc((100% - 8px) / 3)',
            transform: `translateX(${activeIndex * 100}%)`,
            background: 'var(--accent)',
            boxShadow: '0 2px 12px color-mix(in srgb, var(--accent), transparent 50%)',
          }}
        />

        {buttons.map((btn) => {
          const active = mode === btn.mode;
          const hovered = hoveredMode === btn.mode;

          return (
            <button
              key={btn.mode}
              onClick={() => handleModeClick(btn.mode)}
              onMouseEnter={() => setHoveredMode(btn.mode)}
              onMouseLeave={() => setHoveredMode((prev) => (prev === btn.mode ? null : prev))}
              className={`relative z-[1] flex w-[108px] items-center justify-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-all duration-200 active:scale-[0.98] ${
                active
                  ? 'scale-[1.01]'
                  : 'hover:-translate-y-[1px] hover:shadow-[0_4px_14px_rgba(0,0,0,0.22)]'
              }`}
              style={active ? {
                color: 'var(--accent-contrast)',
              } : {
                background: hovered
                  ? 'color-mix(in srgb, var(--surface-2), transparent 18%)'
                  : 'transparent',
                color: hovered ? 'var(--text-strong)' : 'var(--text-muted)',
              }}
              title={`${btn.label} • ${btn.hint}`}
            >
              <span>{btn.icon}</span>
              <span>{btn.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

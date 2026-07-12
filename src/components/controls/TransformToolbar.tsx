import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Hand, Move3D, Paintbrush2, LayoutGrid, ArrowDownToLine, FlipHorizontal2, Droplets } from 'lucide-react';
import type { TransformMode } from '@/hooks/useModelTransform';
import { usePlatformModifier } from '@/hooks/usePlatformModifier';
import { warmTransformGizmoGeometryCache } from '@/components/gizmo/gizmoGeometryCache';

interface TransformToolbarProps {
  mode: TransformMode;
  onModeChange: (mode: TransformMode) => void;
  onModeHover?: (mode: TransformMode | null) => void;
}

export function TransformToolbar({ mode, onModeChange, onModeHover }: TransformToolbarProps) {
  const [hoveredMode, setHoveredMode] = React.useState<TransformMode | null>(null);
  const modKey = usePlatformModifier();
  const { _ } = useLingui();

  const toolbarInnerRef = React.useRef<HTMLDivElement>(null);
  const [collapseToolLabels, setCollapseToolLabels] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    const fullLeft = window.innerWidth / 2 - 321;
    return fullLeft < 340;
  });
  const lastCollapseRef = React.useRef(false);

  const buttons: Array<{ mode: TransformMode; label: string; icon: React.ReactNode; hint: string }> = [
    { mode: 'select', label: _(msg`Select`), icon: <Hand className="w-4 h-4" />, hint: _(msg`Select and inspect model`) },
    { mode: 'transform', label: _(msg`Modify`), icon: <Move3D className="w-4 h-4" />, hint: _(msg`Move, rotate, and scale`) },
    { mode: 'placeOnFace', label: _(msg({ message: 'On-Face', comment: 'Toolbar button label. Short for "lay the model flat on a selected face"; keep it terse so the toolbar pill stays narrow.' })), icon: <ArrowDownToLine className="w-4 h-4" />, hint: _(msg`Orient flat against plate`) },
    { mode: 'mirror', label: _(msg`Mirror`), icon: <FlipHorizontal2 className="w-4 h-4" />, hint: _(msg`Mirror across X, Y, or Z`) },
    { mode: 'hollowing', label: _(msg`Hollow`), icon: <Droplets className="w-4 h-4" />, hint: _(msg`Create cavity or open-face shell`) },
    { mode: 'smoothing', label: _(msg`Smooth`), icon: <Paintbrush2 className="w-4 h-4" />, hint: _(msg`Sculpt and smooth surface`) },
    { mode: 'arrange', label: _(msg`Arrange`), icon: <LayoutGrid className="w-4 h-4" />, hint: _(msg`Auto-arrange models on plate`) },
  ];

  React.useEffect(() => {
    const update = () => {
      // Toolbar full width with all labels: ~642px
      // Centered at innerWidth/2, so left edge = innerWidth/2 - 321
      // Collapse when left edge is too close to the 320px panel
      const fullLeft = window.innerWidth / 2 - 321;
      const tooClose = fullLeft < 340;
      if (tooClose !== lastCollapseRef.current) {
        lastCollapseRef.current = tooClose;
        setCollapseToolLabels(tooClose);
      }
    };

    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const handleModeClick = React.useCallback((next: TransformMode) => {
    React.startTransition(() => {
      onModeChange(next);
    });
  }, [onModeChange]);

  const handleModeHoverChange = React.useCallback((next: TransformMode | null) => {
    if (next === 'transform') {
      warmTransformGizmoGeometryCache();
    }
    setHoveredMode(next);
    onModeHover?.(next);
  }, [onModeHover]);

  const handleModeLeave = React.useCallback((modeValue: TransformMode) => {
    const next = hoveredMode === modeValue ? null : hoveredMode;
    setHoveredMode(next);
    onModeHover?.(next);
  }, [hoveredMode, onModeHover]);

  return (
    <div
      className="fixed top-16 left-1/2 z-30 -translate-x-1/2 flex items-center pointer-events-auto"
    >
    <div
      className="rounded-full"
      style={{
        padding: '2px',
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 70%), var(--border-subtle), color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 70%))',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.2)',
      }}
    >
      <div
        ref={toolbarInnerRef}
        className="relative grid items-center rounded-full px-1 py-1 gap-1"
        onMouseLeave={() => {
          setHoveredMode(null);
          onModeHover?.(null);
        }}
        style={{
          gridTemplateColumns: `repeat(${buttons.length}, auto)`,
          background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 50%)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {buttons.map((btn, index) => {
          const active = mode === btn.mode;
          const hovered = hoveredMode === btn.mode;

          return (
            <button
              key={btn.mode}
              onClick={() => handleModeClick(btn.mode)}
              onMouseEnter={() => handleModeHoverChange(btn.mode)}
              onFocus={() => handleModeHoverChange(btn.mode)}
              className={`relative z-[1] flex items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-all duration-200 active:scale-[0.98] h-[34px] ${
                active
                  ? 'scale-[1.01]'
                  : 'hover:-translate-y-[1px] hover:shadow-[0_4px_14px_rgba(0,0,0,0.22)]'
              }`}
              style={active ? {
                background: 'var(--accent-secondary)',
                color: '#000000',
                boxShadow: '0 2px 12px color-mix(in srgb, var(--accent-secondary), transparent 50%)',
              } : {
                background: hovered
                  ? 'color-mix(in srgb, var(--surface-2), transparent 18%)'
                  : 'transparent',
                color: hovered ? 'var(--text-strong)' : 'var(--text-muted)',
              }}
              title={`${btn.label} • ${btn.hint}`}
            >
              <span className="shrink-0">{btn.icon}</span>
              {collapseToolLabels && (hoveredMode ? hoveredMode !== btn.mode : !active) ? null : (
                <span className="whitespace-nowrap overflow-hidden">{btn.label}</span>
              )}
            </button>
          );
        })}
      </div>
      </div>

    </div>
  );
}

'use client';

import React from 'react';
import { Trash2 } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';

export type DebugPrimitiveType =
  | 'pillar'
  | 'merge_y'
  | 'split_y'
  | 'earlobe'
  | 'bridge'
  | 'finger_palm_arm';

export type DebugPrimitiveSizePreset = 'small' | 'medium' | 'large';

const PRIMITIVE_STYLE: Record<DebugPrimitiveType, { tint: string; icon: string }> = {
  pillar: { tint: '#4f8cff', icon: '#93b8ff' },
  merge_y: { tint: '#33c27f', icon: '#8de7b7' },
  split_y: { tint: '#a27bff', icon: '#ccb8ff' },
  earlobe: { tint: '#e56a8a', icon: '#ffc0d1' },
  bridge: { tint: '#44b6d8', icon: '#9ee6fa' },
  finger_palm_arm: { tint: '#f0a84f', icon: '#ffd8a3' },
};

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
    <Card>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded(!expanded)}
              title={expanded ? 'Collapse card' : 'Expand card'}
              className="!p-0.5"
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {expanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Debug Primitives</h3>
          </>
        )}
        right={(
          <IconButton
            onClick={onClear}
            className="!p-1.5 text-red-300 hover:text-red-200"
            title="Clear Debug Models"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </IconButton>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-1 pb-2.5 space-y-2.5">
          <div
            className="rounded-md border px-2 py-1.5"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 68%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
            }}
          >
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>
              Quick primitive generator
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Add test geometry with one click
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md border p-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Size</div>
            <div className="flex items-center gap-1 rounded-md p-0.5" style={{ background: 'var(--surface-0)' }}>
              {(['small', 'medium', 'large'] as const).map((s) => (
                <Button
                  key={s}
                  onClick={() => setSizePreset(s)}
                  variant={sizePreset === s ? 'primary' : 'secondary'}
                  size="sm"
                  className="capitalize"
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {buttons.map((b) => (
              <Button
                key={b.type}
                onClick={() => onAdd(b.type, sizePreset)}
                variant="secondary"
                className="h-[4.35rem] flex flex-col items-center justify-center gap-1 border"
                title={`Add ${b.label}`}
                style={{
                  borderColor: 'color-mix(in srgb, var(--border-subtle), white 8%)',
                  background: 'color-mix(in srgb, var(--surface-1), var(--surface-0) 36%)',
                }}
              >
                <div
                  className="w-9 h-9 rounded-md border flex items-center justify-center"
                  style={{
                    background: `color-mix(in srgb, ${PRIMITIVE_STYLE[b.type].tint}, var(--surface-0) 86%)`,
                    borderColor: `color-mix(in srgb, ${PRIMITIVE_STYLE[b.type].tint}, var(--border-subtle) 45%)`,
                  }}
                >
                  <div style={{ color: PRIMITIVE_STYLE[b.type].icon }}>
                    <PrimitiveIcon type={b.type} />
                  </div>
                </div>
                <div className="text-[10px] text-center leading-tight px-1" style={{ color: 'var(--text-strong)' }}>
                  {b.label}
                </div>
              </Button>
            ))}
          </div>

          <div className="text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            Creates normal scene models (movable, hideable, deletable).
          </div>
        </div>
      )}
    </Card>
  );
}

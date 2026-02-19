"use client";

import React from 'react';
import { Ban, ChevronDown, Focus, Palette, Sparkles } from 'lucide-react';
import type { SelectionHighlightMode } from '@/components/selection';

type SelectionHighlightDropdownProps = {
  value: SelectionHighlightMode;
  onChange: (value: SelectionHighlightMode) => void;
  fullWidth?: boolean;
  className?: string;
};

type Option = {
  value: SelectionHighlightMode;
  label: string;
};

const OPTIONS: Option[] = [
  { value: 'spotlight', label: 'Spotlight' },
  { value: 'fresnel', label: 'Fresnel' },
  { value: 'tint', label: 'Mesh Tint' },
  { value: 'none', label: 'None' },
];

function getSelectionIcon(mode: SelectionHighlightMode) {
  switch (mode) {
    case 'spotlight':
      return <Focus className="h-3.5 w-3.5" />;
    case 'fresnel':
      return <Sparkles className="h-3.5 w-3.5" />;
    case 'tint':
      return <Palette className="h-3.5 w-3.5" />;
    case 'none':
      return <Ban className="h-3.5 w-3.5" />;
    default:
      return <Focus className="h-3.5 w-3.5" />;
  }
}

export function SelectionHighlightDropdown({ value, onChange, fullWidth = false, className }: SelectionHighlightDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const currentLabel = React.useMemo(() => {
    return OPTIONS.find((option) => option.value === value)?.label ?? 'Spotlight';
  }, [value]);

  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className={`relative pointer-events-auto ${className ?? ''}`}>
      <button
        type="button"
        className={`ui-button ui-button-secondary inline-flex items-center gap-1.5 !px-2 !py-1.5 text-xs transition-all duration-150 hover:-translate-y-[1px] hover:shadow-[0_4px_14px_rgba(0,0,0,0.22)] ${fullWidth ? 'w-full justify-between' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        title="Selection highlight mode"
      >
        <span style={{ color: 'var(--accent)' }}>{getSelectionIcon(value)}</span>
        <span className="max-w-[8.8rem] truncate text-left" style={{ color: 'var(--text-muted)' }}>
          {currentLabel}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-56 rounded-lg border p-1.5 shadow-lg"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), black 4%)',
          }}
        >
          {OPTIONS.map((option) => {
            const selected = value === option.value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors ${selected ? 'ui-button-primary' : 'ui-button-secondary'}`}
              >
                <span className="inline-flex items-center gap-2">
                  <span style={{ color: selected ? 'var(--accent-contrast)' : 'var(--accent)' }}>
                    {getSelectionIcon(option.value)}
                  </span>
                  <span style={{ color: selected ? 'var(--accent-contrast)' : 'var(--text-strong)' }}>
                    {option.label}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

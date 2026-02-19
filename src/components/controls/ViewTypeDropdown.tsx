"use client";

import React from 'react';
import {
  AppWindow,
  Camera,
  ChevronDown,
  Grid3X3,
  Layers3,
  Paintbrush,
  Scan,
  Sparkles,
  Wand2,
  Eye,
} from 'lucide-react';
import { MESH_SHADER_OPTIONS, type MeshShaderType } from '@/features/shaders/mesh';

type ViewTypeDropdownProps = {
  value: MeshShaderType | null;
  onChange: (value: MeshShaderType | null) => void;
  fullWidth?: boolean;
  className?: string;
  iconOnly?: boolean;
  title?: string;
};

function getViewTypeIcon(type: MeshShaderType | null) {
  if (type === null) return <Wand2 className="h-3.5 w-3.5" />;

  switch (type) {
    case 'soft_clay':
      return <Paintbrush className="h-3.5 w-3.5" />;
    case 'toon':
      return <Sparkles className="h-3.5 w-3.5" />;
    case 'normal_debug':
      return <Scan className="h-3.5 w-3.5" />;
    case 'wireframe':
      return <Grid3X3 className="h-3.5 w-3.5" />;
    case 'opaque_wire_mesh':
      return <Layers3 className="h-3.5 w-3.5" />;
    case 'xray':
      return <Eye className="h-3.5 w-3.5" />;
    default:
      return <AppWindow className="h-3.5 w-3.5" />;
  }
}

export function ViewTypeDropdown({
  value,
  onChange,
  fullWidth = false,
  className,
  iconOnly = false,
  title,
}: ViewTypeDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const currentLabel = React.useMemo(() => {
    if (value === null) return 'Default';
    return MESH_SHADER_OPTIONS.find((opt) => opt.value === value)?.label ?? 'Default';
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
        className={`ui-button ui-button-secondary inline-flex items-center gap-1.5 text-xs transition-all duration-150 hover:-translate-y-[1px] hover:shadow-[0_4px_14px_rgba(0,0,0,0.22)] ${
          iconOnly ? '!p-2 justify-center' : '!px-2 !py-1.5'
        } ${fullWidth ? 'w-full justify-between' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        title={title ?? (iconOnly ? `Camera view mode: ${currentLabel}` : 'View type')}
      >
        {iconOnly ? (
          <Camera className="h-4 w-4" style={{ color: 'var(--text-strong)' }} />
        ) : (
          <>
            <span style={{ color: 'var(--accent)' }}>{getViewTypeIcon(value)}</span>
            <span className="max-w-[8.8rem] truncate text-left" style={{ color: 'var(--text-muted)' }}>
              {currentLabel}
            </span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-64 rounded-lg border p-1.5 shadow-lg"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), black 4%)',
          }}
        >
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors ${value === null ? 'ui-button-primary' : 'ui-button-secondary'}`}
          >
            <span className="inline-flex items-center gap-2">
              <span style={{ color: value === null ? 'var(--accent-contrast)' : 'var(--accent)' }}>{getViewTypeIcon(null)}</span>
              <span style={{ color: value === null ? 'var(--accent-contrast)' : 'var(--text-strong)' }}>Default (project setting)</span>
            </span>
          </button>

          <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />

          {MESH_SHADER_OPTIONS.map((option) => {
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
                  <span style={{ color: selected ? 'var(--accent-contrast)' : 'var(--accent)' }}>{getViewTypeIcon(option.value)}</span>
                  <span style={{ color: selected ? 'var(--accent-contrast)' : 'var(--text-strong)' }}>{option.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

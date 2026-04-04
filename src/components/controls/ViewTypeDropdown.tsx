"use client";

import React from 'react';
import {
  AppWindow,
  Camera,
  Grid3X3,
  Layers3,
  Paintbrush,
  Scan,
  Sparkles,
  Wand2,
  Eye,
} from 'lucide-react';
import { MESH_SHADER_OPTIONS, type MeshShaderType } from '@/features/shaders/mesh';
import { SelectDropdown } from '@/components/ui/SelectDropdown';

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
  const dropdownValue = (value ?? '__default__') as MeshShaderType | '__default__';

  const currentLabel = React.useMemo(() => {
    if (value === null) return 'Default';
    return MESH_SHADER_OPTIONS.find((opt) => opt.value === value)?.label ?? 'Default';
  }, [value]);

  const dropdownOptions = React.useMemo(
    () => [
      {
        value: '__default__' as const,
        label: 'Default (project setting)',
        icon: getViewTypeIcon(null),
      },
      ...MESH_SHADER_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        icon: getViewTypeIcon(option.value),
      })),
    ],
    [],
  );

  return (
    <div className={`pointer-events-auto ${className ?? ''}`}>
      <SelectDropdown
        value={dropdownValue}
        onChange={(nextValue) => {
          if (nextValue === '__default__') {
            onChange(null);
            return;
          }
          onChange(nextValue as MeshShaderType);
        }}
        ariaLabel={title ?? (iconOnly ? `Camera view mode: ${currentLabel}` : 'View type')}
        title={title ?? (iconOnly ? `Camera view mode: ${currentLabel}` : 'View type')}
        options={dropdownOptions}
        className="space-y-0"
        selectClassName={`${iconOnly ? '!h-8 !w-8 !p-2 justify-center' : '!h-8 !px-2 !py-1.5 text-xs'} ${fullWidth ? 'w-full' : ''}`}
        menuAlign="right"
        menuClassName="!w-64"
        hideSelectedText={iconOnly}
        selectedDisplayAlignment={iconOnly ? 'center' : 'left'}
        selectedDisplay={iconOnly ? <Camera className="h-4 w-4" style={{ color: 'var(--text-strong)' }} /> : undefined}
        leadingDisplay={iconOnly ? undefined : <span style={{ color: 'var(--accent)' }}>{getViewTypeIcon(value)}</span>}
      />
    </div>
  );
}

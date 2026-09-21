"use client";

import React from 'react';
import {
  AppWindow,
  Camera,
  Grid3X3,
  Layers3,
  Paintbrush,
  Scan,
  Eye,
} from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { MESH_SHADER_OPTIONS, type MeshShaderType } from '@/features/shaders/mesh';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { AlertDiamondIcon } from '@/components/atoms/AlertDiamondIcon';

type ViewTypeDropdownProps = {
  value: MeshShaderType;
  onChange: (value: MeshShaderType) => void;
  fullWidth?: boolean;
  className?: string;
  iconOnly?: boolean;
  title?: string;
};

function getViewTypeIcon(type: MeshShaderType) {
  switch (type) {
    case 'soft_clay':
      return <Paintbrush className="h-3.5 w-3.5" />;
    case 'normal_debug':
      return <Scan className="h-3.5 w-3.5" />;
    case 'wireframe':
      return <Grid3X3 className="h-3.5 w-3.5" />;
    case 'overhang_heatmap':
      return <AlertDiamondIcon className="h-3.5 w-3.5" />;
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
  const { _ } = useLingui();

  const currentLabel = React.useMemo(() => {
    const option = MESH_SHADER_OPTIONS.find((opt) => opt.value === value);
    return option ? _(option.label) : value;
  }, [_, value]);

  const dropdownOptions = React.useMemo(
    () => MESH_SHADER_OPTIONS.map((option) => ({
      value: option.value,
      label: _(option.label),
      icon: getViewTypeIcon(option.value),
    })),
    [_],
  );

  const resolvedTitle = title
    ?? (iconOnly ? _(msg`Camera view mode: ${currentLabel}`) : _(msg`View type`));

  // Icon-only triggers carry the camera, since the mode's name does not fit. With
  // room, the name and the chevron read as the dropdown on their own: the chevron
  // sits close to the edge and the trigger's right padding holds the text off it,
  // so it reads as label then chevron rather than label, gap, chevron, larger gap.
  return (
    <div className={`pointer-events-auto ${className ?? ''}`}>
      <SelectDropdown
        value={value}
        onChange={(nextValue) => onChange(nextValue as MeshShaderType)}
        ariaLabel={resolvedTitle}
        title={resolvedTitle}
        options={dropdownOptions}
        className="space-y-0"
        selectClassName={`${iconOnly ? '!h-8 !w-8 !p-0' : '!h-8 !py-1.5 !pl-2 !pr-7 text-xs'} ${fullWidth ? 'w-full' : ''}`}
        chevronClassName="right-1.5"
        hideChevron={iconOnly}
        menuAlign="right"
        menuClassName="!w-64"
        hideSelectedText={iconOnly}
        selectedDisplayAlignment={iconOnly ? 'center' : 'left'}
        selectedDisplay={iconOnly ? <Camera className="h-4 w-4" style={{ color: 'var(--text-strong)' }} /> : undefined}
      />
    </div>
  );
}

"use client";

import React from 'react';
import { Ban, Focus, Palette, Sparkles } from 'lucide-react';
import type { SelectionHighlightMode } from '@/components/selection';
import { SelectDropdown } from '@/components/ui/SelectDropdown';

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
  return (
    <div className={`pointer-events-auto ${className ?? ''}`}>
      <SelectDropdown
        value={value}
        onChange={(nextValue) => onChange(nextValue as SelectionHighlightMode)}
        ariaLabel="Selection highlight mode"
        options={OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
          icon: getSelectionIcon(option.value),
        }))}
        className="space-y-0"
        selectClassName={`!h-8 !px-2 !py-1.5 text-xs ${fullWidth ? 'w-full' : 'min-w-[10.75rem]'}`}
        menuAlign="right"
        menuClassName="!w-56"
        leadingDisplay={<span style={{ color: 'var(--accent)' }}>{getSelectionIcon(value)}</span>}
      />
    </div>
  );
}

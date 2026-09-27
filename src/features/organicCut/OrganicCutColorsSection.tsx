import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import {
  DEFAULT_ORGANIC_CUT_COLORS,
  saveOrganicCutColors,
  type OrganicCutColors,
} from './organicCutColors';
import { useOrganicCutColors } from './useOrganicCutColors';
import { ColorSwatchInput } from '@/components/atoms';

// Module-level descriptors: the React Compiler leaves module scope alone, so the
// generated message ids stay stable in production builds.
const FIELDS: { key: keyof OrganicCutColors; label: MessageDescriptor; hint: MessageDescriptor }[] = [
  { key: 'seam', label: msg`Seam`, hint: msg`The cut line you draw.` },
  { key: 'seamHover', label: msg`Seam (hover)`, hint: msg`The seam while the cursor is over it.` },
  { key: 'seamInactive', label: msg`Seam (other loops)`, hint: msg`Loops of a multi-loop cut you are not editing.` },
  { key: 'seamGlow', label: msg`Seam glow`, hint: msg`Halo around the hovered seam.` },
  { key: 'cutSurface', label: msg`Cut surface`, hint: msg`The contour membrane and the flat cut plane.` },
  { key: 'tenonFront', label: msg`Tenon (near faces)`, hint: msg`The tenon's faces turned toward you.` },
  { key: 'tenonBack', label: msg`Tenon (far faces)`, hint: msg`Far faces, darker so the shape reads solid.` },
  { key: 'tenonEdge', label: msg`Tenon edges`, hint: msg`The tenon's silhouette lines.` },
  { key: 'mortiseFront', label: msg`Mortise (near faces)`, hint: msg`The hole carved in the other half.` },
  { key: 'mortiseBack', label: msg`Mortise (far faces)`, hint: msg`Far faces, darker so the shape reads solid.` },
  { key: 'mortiseEdge', label: msg`Mortise edges`, hint: msg`The mortise's silhouette lines.` },
  { key: 'tenonHandle', label: msg`Tenon handle`, hint: msg`The dot you drag to slide the tenon.` },
  { key: 'markerFirst', label: msg`First waypoint`, hint: msg`The point the loop starts from.` },
  { key: 'markerPoint', label: msg`Waypoint`, hint: msg`Every other point on the loop.` },
  { key: 'markerSelected', label: msg`Waypoint (selected)`, hint: msg`The point you clicked.` },
  { key: 'markerDragging', label: msg`Waypoint (dragging)`, hint: msg`The point being dragged.` },
];

export function OrganicCutColorsSection() {
  const { _ } = useLingui();
  const colors = useOrganicCutColors();

  const set = (key: keyof OrganicCutColors, value: string) => {
    saveOrganicCutColors({ ...colors, [key]: value });
  };

  return (
    <section
      className="rounded-xl border p-2.5"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-1)',
      }}
    >
      <div className="mb-2">
        <h4 className="text-[12px] font-semibold" style={{ color: 'var(--text-strong)' }}>
          <Trans>Cut Tool Colors</Trans>
        </h4>
        <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          <Trans>Seam, cut surface, tenon, mortise, and waypoint colors for the Cut tool.</Trans>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {FIELDS.map(({ key, label, hint }) => (
          <div
            key={key}
            className="rounded-md border px-2 py-1.5"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-0), transparent 8%)',
            }}
            title={_(hint)}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_10.75rem] items-center gap-2.5">
              <label
                className="block truncate text-xs font-semibold"
                style={{ color: 'var(--text-strong)' }}
              >
                {_(label)}
              </label>
              <div className="flex min-w-0 items-center gap-1.5">
                <ColorSwatchInput
                  value={colors[key]}
                  onChange={(next) => set(key, next)}
                  className="h-7 w-8"
                />
                <input
                  type="text"
                  value={colors[key]}
                  onChange={(e) => set(key, e.target.value)}
                  className="ui-input h-7 min-w-0 flex-1 text-[11px] font-mono"
                  placeholder={DEFAULT_ORGANIC_CUT_COLORS[key]}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

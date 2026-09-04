import {
  DEFAULT_ORGANIC_CUT_COLORS,
  saveOrganicCutColors,
  type OrganicCutColors,
} from './organicCutColors';
import { useOrganicCutColors } from './useOrganicCutColors';

const FIELDS: { key: keyof OrganicCutColors; label: string; hint: string }[] = [
  { key: 'seam', label: 'Seam', hint: 'The cut line you draw.' },
  { key: 'seamHover', label: 'Seam (hover)', hint: 'The seam while the cursor is over it.' },
  { key: 'seamInactive', label: 'Seam (other loops)', hint: 'Loops of a multi-loop cut you are not editing.' },
  { key: 'seamGlow', label: 'Seam glow', hint: 'Halo around the hovered seam.' },
  { key: 'cutSurface', label: 'Cut surface', hint: 'The contour membrane and the flat cut plane.' },
  { key: 'tenonFront', label: 'Tenon (near faces)', hint: "The tenon's faces turned toward you." },
  { key: 'tenonBack', label: 'Tenon (far faces)', hint: 'Far faces, darker so the shape reads solid.' },
  { key: 'tenonEdge', label: 'Tenon edges', hint: "The tenon's silhouette lines." },
  { key: 'mortiseFront', label: 'Mortise (near faces)', hint: 'The hole carved in the other half.' },
  { key: 'mortiseBack', label: 'Mortise (far faces)', hint: 'Far faces, darker so the shape reads solid.' },
  { key: 'mortiseEdge', label: 'Mortise edges', hint: "The mortise's silhouette lines." },
  { key: 'tenonHandle', label: 'Tenon handle', hint: 'The dot you drag to slide the tenon.' },
  { key: 'markerFirst', label: 'First waypoint', hint: 'The point the loop starts from.' },
  { key: 'markerPoint', label: 'Waypoint', hint: 'Every other point on the loop.' },
  { key: 'markerSelected', label: 'Waypoint (selected)', hint: 'The point you clicked.' },
  { key: 'markerDragging', label: 'Waypoint (dragging)', hint: 'The point being dragged.' },
];

export function OrganicCutColorsSection() {
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
          Cut Tool Colors
        </h4>
        <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          Seam, cut surface, tenon, mortise, and waypoint colors for the Cut tool.
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
            title={hint}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_10.75rem] items-center gap-2.5">
              <label
                className="block truncate text-xs font-semibold"
                style={{ color: 'var(--text-strong)' }}
              >
                {label}
              </label>
              <div className="flex min-w-0 items-center gap-1.5">
                <input
                  type="color"
                  value={colors[key]}
                  onChange={(e) => set(key, e.target.value)}
                  className="h-7 w-8 shrink-0 rounded border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
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

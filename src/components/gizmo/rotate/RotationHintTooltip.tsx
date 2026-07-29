import { useEffect, useState } from 'react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';

/**
 * Cursor-following tooltip shown on rotation ring hover.
 *
 * Rotation is picked from the dial: click the handle to arm, click a tick to
 * rotate by that angle from the 0-degree reference; dragging the handle
 * rotates freely. This hint is the one piece of chrome that teaches that, so
 * its copy must match the interaction in GizmoRotation.
 */
export function RotationHintTooltip() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      setVisible((e as CustomEvent).detail?.visible ?? false);
    };
    window.addEventListener('dragonfruit:rotation-hint', handler);
    return () => window.removeEventListener('dragonfruit:rotation-hint', handler);
  }, []);

  return (
    <MouseTooltip visible={visible} offset={{ x: 20, y: -40 }}>
      <div
        className="rounded px-2 py-1.5 text-[11px] leading-tight font-medium"
        style={{
          background: 'rgba(0, 0, 0, 0.8)',
          color: 'var(--text-strong, #e0e0e0)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          whiteSpace: 'nowrap',
        }}
      >
        <div>Click handle to aim</div>
        <div className="mt-0.5 opacity-70">
          click a tick to rotate by that angle
        </div>
        <div className="mt-0.5 opacity-70">
          Esc cancels &nbsp;|&nbsp; drag orbits
        </div>
      </div>
    </MouseTooltip>
  );
}

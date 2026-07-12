import { useEffect, useState } from 'react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';

// Matches the scale-x handle color (GIZMO_COLORS.xAxis.end) so the readout
// reads as belonging to the squish cube, like SnapAngleReadout's axis colors.
const RATIO_COLOR = '#ff3120';

/**
 * Cursor-following percentage readout while the contact-face squish cube is
 * dragged. Listens to 'dragonfruit:contact-face-ratio' events dispatched by
 * ContactFaceGizmo — the squish counterpart of SnapAngleReadout.
 */
export function ContactFaceRatioReadout() {
    const [state, setState] = useState<{ active: boolean; ratio?: number }>({ active: false });

    useEffect(() => {
        const handler = (e: Event) => {
            setState((e as CustomEvent).detail);
        };
        window.addEventListener('dragonfruit:contact-face-ratio', handler);
        return () => window.removeEventListener('dragonfruit:contact-face-ratio', handler);
    }, []);

    if (!state.active || state.ratio === undefined) return null;

    const percent = Math.round(state.ratio * 100);

    return (
        <MouseTooltip visible offset={{ x: 20, y: -30 }}>
            <div
                className="rounded px-1.5 py-0.5 text-[11px] font-mono font-semibold tabular-nums"
                style={{
                    color: RATIO_COLOR,
                    background: 'rgba(0, 0, 0, 0.75)',
                    border: `1px solid ${RATIO_COLOR}33`,
                    textShadow: `0 0 6px ${RATIO_COLOR}88`,
                }}
            >
                {percent}%
            </div>
        </MouseTooltip>
    );
}
